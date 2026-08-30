import Database from "better-sqlite3";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  readonly path: string;
  readonly deletedOldBackups: readonly string[];
}

/**
 * Matches only the nightly filename this module itself writes:
 * `argos-<ISO timestamp with : and . replaced by ->.db`.
 *
 * Deliberately narrow. It used to be `/^argos-.*\.db$/`, which also swept up
 * every ad-hoc snapshot an operator had taken under the same prefix —
 * `argos-predeploy-…`, `argos-pre-backfill-…` — and those sort **above**
 * every dated backup, because the character after `argos-` is a letter in one
 * case and a digit in the other. `enforceRetention` sorts by name and keeps
 * the first `retention`, so each manual snapshot permanently consumed a slot
 * that a real nightly backup would otherwise hold, and was itself never
 * pruned.
 *
 * Measured on Atlas, 2026-08-30: eight files matched, three of them ad-hoc,
 * leaving **4 real nightly backups** where `retention = 7` promises seven —
 * and narrowing further with every manual snapshot taken.
 *
 * Restricting the pattern makes the module's own claim true again ("filenames
 * encode the timestamp so lexicographic and chronological order coincide" is
 * only true of this shape) and leaves deliberate manual snapshots alone:
 * nothing auto-deletes a file a human took on purpose.
 */
const BACKUP_FILE_PATTERN = /^argos-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

/**
 * `VACUUM INTO` a timestamped file, then prune anything past `retention`
 * (docs/10-milestones.md, M8). Safe against a live, WAL-mode connection —
 * unlike a raw file copy, which can capture a half-written page mid-write —
 * because it reads through SQLite's own consistent-snapshot machinery
 * rather than touching the file bytes directly.
 *
 * Filenames encode the timestamp so lexicographic and chronological order
 * coincide — no separate index or metadata file needed to know which
 * backup is newest.
 */
export function backupDatabase(
  databasePath: string,
  backupsDir: string,
  now: () => Date = () => new Date(),
  retention = 7,
): BackupResult {
  mkdirSync(backupsDir, { recursive: true });

  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupsDir, `argos-${timestamp}.db`);

  const db = new Database(databasePath);
  try {
    db.prepare("VACUUM INTO ?").run(backupPath);
  } finally {
    db.close();
  }

  const deletedOldBackups = enforceRetention(backupsDir, retention);
  return { path: backupPath, deletedOldBackups };
}

function enforceRetention(backupsDir: string, retention: number): string[] {
  const backups = readdirSync(backupsDir)
    .filter((name) => BACKUP_FILE_PATTERN.test(name))
    .sort() // ISO-timestamped names: lexicographic order is chronological.
    .reverse(); // Newest first.

  const toDelete = backups.slice(retention);
  for (const name of toDelete) unlinkSync(join(backupsDir, name));
  return toDelete;
}
