/**
 * MCP Tool Schemas
 * 
 * Defines the tools available to the local agent loop in Electron mode.
 * Web mode does not use these schemas.
 */

export const basicToolSchemas = [
  {
    name: "filesystem.readFile",
    description: "Read a file from the local project",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read" }
      },
      required: ["path"]
    }
  },
  {
    name: "filesystem.writeFile",
    description: "Write content to a local file (requires confirmation)",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write" },
        content: { type: "string", description: "Content to write to the file" }
      },
      required: ["path", "content"]
    }
  }
];

