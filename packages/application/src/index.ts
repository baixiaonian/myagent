/**
 * 应用层公共入口：导出聊天与设置用例，供后端组合根装配。
 * 业务实现留在内部文件，调用方不应通过深路径导入。
 */
export * from "./chat.js";
export * from "./settings.js";
