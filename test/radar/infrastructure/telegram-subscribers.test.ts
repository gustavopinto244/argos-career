import { beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../../src/persistence/infrastructure/db";
import {
  TelegramSubscribers,
  SubscriberNotifier,
  pollSubscribers,
} from "../../../src/radar/infrastructure/telegram-subscribers";

let subscribers: TelegramSubscribers;
let db: ReturnType<typeof createDatabase>;
beforeEach(() => {
  db = createDatabase(":memory:");
  subscribers = new TelegramSubscribers(db);
});

describe("public Telegram subscriptions", () => {
  it("registers private starts, supports stop, ignores groups and persists the cursor", async () => {
    const updates = [
      {
        update_id: 1,
        message: { text: "/start", chat: { id: 10, type: "private" } },
      },
      {
        update_id: 2,
        message: { text: "/start", chat: { id: 20, type: "private" } },
      },
      {
        update_id: 3,
        message: { text: "/stop", chat: { id: 10, type: "private" } },
      },
      {
        update_id: 4,
        message: { text: "/start", chat: { id: -30, type: "group" } },
      },
    ];
    const sent: string[] = [];
    const transport = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).endsWith("getUpdates"))
        return Response.json({ ok: true, result: updates });
      sent.push(JSON.parse(String(init?.body)).chat_id);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    await pollSubscribers(subscribers, "test", transport);
    expect(subscribers.active()).toEqual(["20"]);
    expect(subscribers.offset()).toBe(5);
    expect(sent).toEqual(["10", "20", "10"]);
    expect(new TelegramSubscribers(db).active()).toEqual(["20"]);
  });
  it("retries only failed recipients and removes blocked subscribers", async () => {
    for (const id of ["10", "20", "30"]) subscribers.subscribe(id);
    const sent: string[] = [];
    let fail = true;
    const transport = (async (_url: unknown, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).chat_id;
      sent.push(id);
      if (id === "30") return Response.json({ ok: false }, { status: 403 });
      if (id === "20" && fail)
        return Response.json({ ok: false }, { status: 400 });
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    const notifier = new SubscriberNotifier(subscribers, "test", transport);
    expect((await notifier.sendText("Vagas")).ok).toBe(false);
    fail = false;
    expect((await notifier.sendText("Vagas")).ok).toBe(true);
    expect(sent).toEqual(["10", "20", "30", "20"]);
    expect(subscribers.active()).toEqual(["10", "20"]);
  });
  it("keeps vacancies pending when there are no subscribers", async () => {
    expect(
      (await new SubscriberNotifier(subscribers, "test").sendText("Vagas")).ok,
    ).toBe(false);
  });
});
