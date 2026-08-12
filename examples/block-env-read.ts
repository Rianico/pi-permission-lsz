import { block, matchTool, type PermissionsAPI } from "pi-permission-lsz";

export default function permissions(api: PermissionsAPI) {
  api.onToolUse({
    name: "read env file",
    description: "Do not expose local secrets to the LLM.",
    handler(input) {
      return matchTool(input.tool, {
        read(tool) {
          if (tool.projectPath === ".env") {
            return block("Reading .env could expose local secrets to the LLM.");
          }
        },
      });
    },
  });
}
