import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichToolCall,
  enrichToolCallDetail,
  extractErrorText,
  extractExitCode,
  extractShellOutput,
  type ToolCallTimelineItem,
} from "./tools.ts";

test("enrichToolCallDetail: shell with snake_case parameters and rich object output", () => {
  const detail = enrichToolCallDetail(
    "run_command",
    {
      command_line: "git diff HEAD~1 | head -n 40",
      working_dir: "/workspace/project",
    },
    {
      commandLine: "git diff HEAD~1 | head -n 40",
      workingDir: "/workspace/project",
      exitCode: 0,
      exit_code: 0,
      combinedOutput: "diff --git a/src/index.ts b/src/index.ts\n...",
      formatted_output: "diff --git a/src/index.ts b/src/index.ts\n...",
    },
  );

  assert.deepEqual(detail, {
    type: "shell",
    command: "git diff HEAD~1 | head -n 40",
    cwd: "/workspace/project",
    output: "diff --git a/src/index.ts b/src/index.ts\n...",
    exitCode: 0,
  });
});

test("enrichToolCallDetail: shell with PascalCase parameters and string output", () => {
  const detail = enrichToolCallDetail(
    "default_api:run_command",
    {
      CommandLine: "ls -la",
      Cwd: "/workspace",
    },
    "total 0\ndrwxr-xr-x 2 user staff 64 Oct 16 12:00 .",
  );

  assert.deepEqual(detail, {
    type: "shell",
    command: "ls -la",
    cwd: "/workspace",
    output: "total 0\ndrwxr-xr-x 2 user staff 64 Oct 16 12:00 .",
  });
});

test("enrichToolCallDetail: read_file / view_file with StartLine and EndLine", () => {
  const detail = enrichToolCallDetail(
    "view_file",
    {
      AbsolutePath: "/workspace/src/index.ts",
      StartLine: 10,
      EndLine: 25,
    },
    "function main() {\n  return 42;\n}",
  );

  assert.deepEqual(detail, {
    type: "read",
    filePath: "/workspace/src/index.ts",
    content: "function main() {\n  return 42;\n}",
    offset: 10,
    limit: 16,
  });
});

test("enrichToolCallDetail: write_to_file with TargetFile and CodeContent", () => {
  const detail = enrichToolCallDetail(
    "write_to_file",
    {
      TargetFile: "/workspace/notes.txt",
      CodeContent: "hello world\n",
    },
    "Success",
  );

  assert.deepEqual(detail, {
    type: "write",
    filePath: "/workspace/notes.txt",
    content: "hello world\n",
  });
});

test("enrichToolCallDetail: replace_file_content with TargetContent and ReplacementContent", () => {
  const detail = enrichToolCallDetail(
    "replace_file_content",
    {
      TargetFile: "/workspace/config.json",
      TargetContent: '"debug": false',
      ReplacementContent: '"debug": true',
    },
    "OK",
  );

  assert.deepEqual(detail, {
    type: "edit",
    filePath: "/workspace/config.json",
    oldString: '"debug": false',
    newString: '"debug": true',
  });
});

test("enrichToolCallDetail: search_web with web results", () => {
  const detail = enrichToolCallDetail(
    "search_web",
    {
      query: "paseo provider plugin docs",
    },
    {
      content: "Found 2 results",
      results: [
        { title: "Paseo Docs", url: "https://paseo.dev" },
        { title: "Plugin API", url: "https://paseo.dev/plugins" },
      ],
    },
  );

  assert.deepEqual(detail, {
    type: "search",
    query: "paseo provider plugin docs",
    toolName: "web_search",
    content: "Found 2 results",
    webResults: [
      { title: "Paseo Docs", url: "https://paseo.dev" },
      { title: "Plugin API", url: "https://paseo.dev/plugins" },
    ],
  });
});

test("enrichToolCallDetail: read_url_content", () => {
  const detail = enrichToolCallDetail(
    "read_url_content",
    {
      Url: "https://example.com/api",
    },
    "# API documentation",
  );

  assert.deepEqual(detail, {
    type: "fetch",
    url: "https://example.com/api",
    result: "# API documentation",
  });
});

test("enrichToolCallDetail: invoke_subagent", () => {
  const detail = enrichToolCallDetail(
    "invoke_subagent",
    {
      Subagents: [
        {
          TypeName: "research",
          Prompt: "Explore the codebase",
        },
      ],
    },
    "Subagent finished successfully",
  );

  assert.deepEqual(detail, {
    type: "sub_agent",
    subAgentType: "research",
    description: "Explore the codebase",
    log: "Subagent finished successfully",
  });
});

test("enrichToolCallDetail: unknown tool fallback", () => {
  const detail = enrichToolCallDetail(
    "custom_database_query",
    { query: "SELECT * FROM users" },
    { rows: [] },
  );

  assert.deepEqual(detail, {
    type: "unknown",
    input: { query: "SELECT * FROM users" },
    output: { rows: [] },
  });
});

test("enrichToolCall: enriches running and completed tool calls", () => {
  const runningItem: ToolCallTimelineItem = {
    type: "tool_call",
    id: "call-1",
    callId: "call-1",
    name: "run_command",
    status: "running",
    error: null,
    detail: {
      type: "unknown",
      input: {
        command_line: "pnpm test",
        working_dir: "/app",
      },
      output: null,
    },
  };

  const enrichedRunning = enrichToolCall(runningItem);
  assert.equal(enrichedRunning.status, "running");
  assert.deepEqual(enrichedRunning.detail, {
    type: "shell",
    command: "pnpm test",
    cwd: "/app",
  });

  const completedItem: ToolCallTimelineItem = {
    ...runningItem,
    status: "completed",
    detail: {
      type: "unknown",
      input: {
        command_line: "pnpm test",
        working_dir: "/app",
      },
      output: {
        combinedOutput: "PASS test/index.test.ts",
        exitCode: 0,
      },
    },
  };

  const enrichedCompleted = enrichToolCall(completedItem);
  assert.equal(enrichedCompleted.status, "completed");
  assert.deepEqual(enrichedCompleted.detail, {
    type: "shell",
    command: "pnpm test",
    cwd: "/app",
    output: "PASS test/index.test.ts",
    exitCode: 0,
  });
});

test("enrichToolCall: sanitizes failed tool calls with null error", () => {
  const failedItem: ToolCallTimelineItem = {
    type: "tool_call",
    id: "call-2",
    callId: "call-2",
    name: "run_command",
    status: "failed",
    error: null,
    detail: {
      type: "unknown",
      input: {
        command_line: "cargo check",
      },
      output: {
        combinedOutput: "error[E0432]: unresolved import",
        exitCode: 1,
      },
    },
  };

  const enrichedFailed = enrichToolCall(failedItem);
  assert.equal(enrichedFailed.status, "failed");
  assert.equal(enrichedFailed.error, "error[E0432]: unresolved import");
  assert.deepEqual(enrichedFailed.detail, {
    type: "shell",
    command: "cargo check",
    output: "error[E0432]: unresolved import",
    exitCode: 1,
  });
});

test("enrichToolCall: preserves existing non-null errors and non-unknown details", () => {
  const customItem: ToolCallTimelineItem = {
    type: "tool_call",
    id: "call-3",
    callId: "call-3",
    name: "edit",
    status: "failed",
    error: "Custom error",
    detail: {
      type: "edit",
      filePath: "/app/src.ts",
      oldString: "foo",
      newString: "bar",
    },
  };

  const enriched = enrichToolCall(customItem);
  assert.equal(enriched.error, "Custom error");
  assert.deepEqual(enriched.detail, customItem.detail);
});
