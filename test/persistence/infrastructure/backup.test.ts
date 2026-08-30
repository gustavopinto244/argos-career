import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../../src/persistence/infrastructure/db";
import { runs } from "../../../src/persistence/infrastructure/schema";
import { backupDatabase } from "../../../src/persistence/infrastructure/backup";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-backup-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function migratedDb(path: string) {
  const db = createDatabase(path);
  runMigrations(db);
  return db;
}

describe("backupDatabase", () => {
  it("produces a valid, independently-readable SQLite file", () => {
    const databasePath = join(dir, "argos.db");
    migratedDb(databasePath);

    const result = backupDatabase(databasePath, join(dir, "backups"));

    expect(existsSync(result.path)).toBe(true);
    const backup = new Database(result.path, { readonly: true });
    const tables = backup
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    backup.close();
    expect(tables.some((t) => t.name === "postings")).toBe(true);
  });

  it("captures the data present at backup time", () => {
    const databasePath = join(dir, "argos.db");
    const db = migratedDb(databasePath);
    db.insert(runs)
      .values({ runId: "run-1", kind: "collect", startedAt: new Date() })
      .run();

    const result = backupDatabase(databasePath, join(dir, "backups"));

    const backup = new Database(result.path, { readonly: true });
    const row = backup.prepare("SELECT run_id FROM runs").get() as
      { run_id: string } | undefined;
    backup.close();
    expect(row?.run_id).toBe("run-1");
  });

  it("names backups so lexicographic order matches chronological order", () => {
    const databasePath = join(dir, "argos.db");
    migratedDb(databasePath);
    const backupsDir = join(dir, "backups");

    const first = backupDatabase(
      databasePath,
      backupsDir,
      () => new Date("2026-08-15T03:00:00.000Z"),
      100,
    );
    const second = backupDatabase(
      databasePath,
      backupsDir,
      () => new Date("2026-08-16T03:00:00.000Z"),
      100,
    );

    expect([first.path, second.path].slice().sort()).toEqual([
      first.path,
      second.path,
    ]);
  });

  it("prunes backups past the retention count, oldest first", () => {
    const databasePath = join(dir, "argos.db");
    migratedDb(databasePath);
    const backupsDir = join(dir, "backups");
    const days = ["13", "14", "15", "16"];

    let lastResult;
    for (const day of days) {
      lastResult = backupDatabase(
        databasePath,
        backupsDir,
        () => new Date(`2026-08-${day}T03:00:00.000Z`),
        2,
      );
    }

    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toContain("2026-08-15");
    expect(remaining[1]).toContain("2026-08-16");
    expect(lastResult?.deletedOldBackups).toHaveLength(1);
  });

  it("does not let an operator's ad-hoc snapshot consume a retention slot", () => {
    const databasePath = join(dir, "argos.db");
    migratedDb(databasePath);
    const backupsDir = join(dir, "backups");
    mkdirSync(backupsDir, { recursive: true });

    // Real filenames from Atlas. They share the `argos-` prefix, and the
    // character after it is a letter where a nightly backup has a digit — so
    // they sort ABOVE every dated backup, and `enforceRetention` keeps the
    // first `retention` by name. Measured on production 2026-08-30: eight
    // files matched, three of them ad-hoc, leaving 4 real nightly backups
    // where retention = 7 promises seven.
    const adHoc = [
      "argos-predeploy-2026-08-23T18-11-28-540Z.db",
      "argos-pre-backfill-2026-08-30T12-27-05-723Z.db",
    ];
    for (const name of adHoc) writeFileSync(join(backupsDir, name), "snapshot");

    let lastResult;
    for (const day of ["13", "14", "15", "16"]) {
      lastResult = backupDatabase(
        databasePath,
        backupsDir,
        () => new Date(`2026-08-${day}T03:00:00.000Z`),
        2,
      );
    }

    const remaining = readdirSync(backupsDir).sort();
    const nightly = remaining.filter((n) => /^argos-\d{4}-/.test(n));

    // Retention counts nightly backups only, so both slots hold real ones.
    expect(nightly).toHaveLength(2);
    expect(nightly[0]).toContain("2026-08-15");
    expect(nightly[1]).toContain("2026-08-16");
    // And a snapshot a human took on purpose is never auto-deleted.
    for (const name of adHoc) {
      expect(existsSync(join(backupsDir, name))).toBe(true);
    }
    expect(lastResult?.deletedOldBackups).toHaveLength(1);
  });

  it("does not delete unrelated files in the backups directory", () => {
    const databasePath = join(dir, "argos.db");
    migratedDb(databasePath);
    const backupsDir = join(dir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, "README.md"), "not a backup");

    backupDatabase(databasePath, backupsDir, () => new Date(), 0);

    expect(existsSync(join(backupsDir, "README.md"))).toBe(true);
  });
});
