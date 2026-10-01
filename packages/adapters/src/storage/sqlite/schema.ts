/**
 * Drizzle 表映射：为 SQLite 列和 JSON 载荷提供 TypeScript 类型。
 * 实际建表、外键及唯一索引由 migrations/0001_chat.sql 执行；此文件不是迁移执行器。
 */
import type { ChatEvent, Message, Run } from "@myagent/contracts";
import type { StoredSettings, StoredStep } from "@myagent/state";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
// revision 参与命令并发判断，seq 分配持久事件序号，二者有不同推进频率。
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  revision: integer("revision").notNull(),
  seq: integer("seq").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  workspaceId: text("workspace_id"),
});
export const messages = sqliteTable("messages", {
  origin: text("origin", { mode: "json" }).$type<
    NonNullable<Message["origin"]>
  >(),
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  runId: text("run_id").notNull(),
  role: text("role").$type<Message["role"]>().notNull(),
  content: text("content").notNull(),
  status: text("status").$type<Message["status"]>().notNull(),
  replyToId: text("reply_to_id"),
  createdAt: text("created_at").notNull(),
});
// 可索引的 status / requestId 单独存列，完整 DTO 存 JSON；更新时必须同步两种表示。
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
// 只存非密钥配置和 credentialRef；单行约束与其他唯一索引在 SQL 迁移中定义。
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  data: text("data", { mode: "json" }).$type<StoredSettings>().notNull(),
});
// data 的 continuation 不能进入公开 DTO；只由应用构建后续模型上下文。
export const runSteps = sqliteTable("run_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  sessionId: text("session_id").notNull(),
  stepIndex: integer("step_index").notNull(),
  data: text("data", { mode: "json" }).$type<StoredStep>().notNull(),
});
