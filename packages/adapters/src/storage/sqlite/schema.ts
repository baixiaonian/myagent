import type { ChatEvent, Message, Run } from "@myagent/contracts";
import type { StoredSettings } from "@myagent/state";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  revision: integer("revision").notNull(),
  seq: integer("seq").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  runId: text("run_id").notNull(),
  role: text("role").$type<Message["role"]>().notNull(),
  content: text("content").notNull(),
  status: text("status").$type<Message["status"]>().notNull(),
  replyToId: text("reply_to_id"),
  createdAt: text("created_at").notNull(),
});
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  requestId: text("request_id").notNull(),
  status: text("status").$type<Run["status"]>().notNull(),
  data: text("data", { mode: "json" }).$type<Run>().notNull(),
});
export const events = sqliteTable("events", {
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  data: text("data", { mode: "json" }).$type<ChatEvent>().notNull(),
});
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  data: text("data", { mode: "json" }).$type<StoredSettings>().notNull(),
});
