import type { NextConfig } from "next";

const codexRuntimeIncludes = [
  "./node_modules/@openai/codex/**/*",
  "./node_modules/@openai/codex-linux-x64/**/*",
];

const claudeCodeRuntimeIncludes = [
  "./node_modules/@anthropic-ai/claude-code-linux-x64/claude",
  "./node_modules/@anthropic-ai/claude-code-linux-x64/package.json",
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["railway", "tsx", "esbuild", "@esbuild/linux-x64", "@openai/codex", "@openai/codex-linux-x64", "@anthropic-ai/claude-code", "@anthropic-ai/claude-code-linux-x64"],
  outputFileTracingIncludes: {
    "/api/agent-home/codex/device-login": codexRuntimeIncludes,
    "/api/agent-home/claude-code/login": claudeCodeRuntimeIncludes,
    "/api/agent-home/model-proxy": [...codexRuntimeIncludes, ...claudeCodeRuntimeIncludes],
  },
};

export default nextConfig;
