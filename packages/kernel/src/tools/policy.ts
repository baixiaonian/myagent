/**
 * 纯权限计算：判断可信资源声明是否被显式拒绝、工作区默认权限或已批准范围覆盖。
 * 路径必须先由适配器规范化；本模块不读文件、不猜测 Shell 文本的业务意图。
 */
import type {
  PermissionGrant,
  ResourceAccess,
  Workspace,
} from "@myagent/contracts";

export function containsPath(parent: string, child: string): boolean {
  const base = parent.replace(/\/+$/, "");
  return child === base || child.startsWith(`${base}/`);
}
export function coversResource(
  granted: ResourceAccess,
  requested: ResourceAccess,
): boolean {
  if (granted.kind !== requested.kind) return false;
  if (granted.kind === "path" && requested.kind === "path")
    return (
      containsPath(granted.target, requested.target) &&
      (granted.access === "write" || requested.access === "read")
    );
  return (
    granted.target === requested.target && granted.access === requested.access
  );
}
export function evaluatePermissions(input: {
  workspace: Workspace | null;
  sessionId: string;
  invocationId: string;
  fingerprint: string;
  toolVersion?: string;
  resources: ResourceAccess[];
  grants: PermissionGrant[];
  /** 由可信应用服务提供的本轮只读资源，不接受模型参数赋权。 */
  trustedReadPaths?: readonly string[];
}): { decision: "allow" | "deny" | "ask"; missing: ResourceAccess[] } {
  const grants = input.grants.filter(
    (grant) =>
      !grant.revokedAt &&
      (grant.decision === "deny" ||
        !grant.resources.some((resource) => resource.kind === "mcp") ||
        grant.toolVersion === input.toolVersion) &&
      grant.workspaceId === input.workspace?.id &&
      (grant.scope === "workspace" || grant.sessionId === input.sessionId) &&
      (grant.scope !== "once" ||
        (grant.invocationId === input.invocationId &&
          grant.fingerprint === input.fingerprint)),
  );
  const missing: ResourceAccess[] = [];
  for (const resource of input.resources) {
    if (
      grants.some(
        (grant) =>
          grant.decision === "deny" &&
          grant.resources.some((scope) => coversResource(scope, resource)),
      )
    )
      return { decision: "deny", missing: [resource] };
    if (
      resource.kind === "path" &&
      resource.access === "read" &&
      input.trustedReadPaths?.some((root) =>
        containsPath(root, resource.target),
      )
    )
      continue;
    if (
      resource.kind === "path" &&
      input.workspace &&
      containsPath(input.workspace.path, resource.target)
    )
      continue;
    if (
      !grants.some(
        (grant) =>
          grant.decision === "allow" &&
          grant.resources.some((scope) => coversResource(scope, resource)),
      )
    )
      missing.push(resource);
  }
  return { decision: missing.length ? "ask" : "allow", missing };
}
