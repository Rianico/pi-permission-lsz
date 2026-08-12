import { matchTool, type PermissionsAPI, request } from "pi-permission-lsz";

export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "GitHub release",
    description: "Ask before creating a release through pi-mcp-adapter.",
    handler(input) {
      return matchTool(input.tool, {
        custom: {
          github_create_release(tool) {
            return request({
              guidance: `Check the tag, target repository, and release notes.\n\n${tool.detail}`,
              approveLabel: "Create release",
              rejectLabel: "Cancel release",
            });
          },
        },
      });
    },
  });
}
