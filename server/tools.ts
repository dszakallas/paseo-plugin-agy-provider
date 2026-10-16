import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

export type ToolCallTimelineItem = Extract<ProviderTimelineItem, { type: "tool_call" }>;

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function getStringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val;
    }
  }
  return undefined;
}

function getAnyStringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") {
      return val;
    }
  }
  return undefined;
}

function getNumberField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "number" && !Number.isNaN(val)) {
      return val;
    }
    if (typeof val === "string") {
      const parsed = Number(val);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function normalizeToolName(name: string): string {
  const parts = name.split(":");
  const base = parts[parts.length - 1] ?? name;
  return base.trim().toLowerCase();
}

export function extractShellOutput(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.combinedOutput === "string") return record.combinedOutput;
    if (typeof record.formatted_output === "string") return record.formatted_output;
    if (typeof record.output === "string") return record.output;
    if (typeof record.stdout === "string" || typeof record.stderr === "string") {
      const stdout = typeof record.stdout === "string" ? record.stdout : "";
      const stderr = typeof record.stderr === "string" ? record.stderr : "";
      if (stdout && stderr) return `${stdout}\n${stderr}`;
      return stdout || stderr;
    }
    if (typeof record.result === "string") return record.result;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const err = record.error as Record<string, unknown>;
      if (typeof err.message === "string") return err.message;
    }
  }
  return undefined;
}

export function extractExitCode(output: unknown): number | null | undefined {
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.exitCode === "number") return record.exitCode;
    if (typeof record.exit_code === "number") return record.exit_code;
    if (typeof record.code === "number") return record.code;
  }
  return undefined;
}

export function extractErrorText(output: unknown): string | undefined {
  if (typeof output === "string" && output.trim().length > 0) return output;
  const shellOut = extractShellOutput(output);
  if (shellOut && shellOut.trim().length > 0) return shellOut;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim().length > 0) return record.error;
    if (typeof record.message === "string" && record.message.trim().length > 0) return record.message;
  }
  return undefined;
}

export function enrichToolCallDetail(
  name: string,
  input: unknown,
  output: unknown,
): ProviderToolCallDetail {
  const normName = normalizeToolName(name);
  const inRecord = parseJsonRecord(input);

  // 1. Shell command execution
  const isShellName =
    normName === "run_command" ||
    normName === "runcommand" ||
    normName === "bash" ||
    normName === "shell" ||
    normName === "exec_command" ||
    normName === "execute_command" ||
    normName === "terminal";
  const command = getStringField(
    inRecord,
    "command_line",
    "CommandLine",
    "command",
    "cmd",
  );
  if (command && (isShellName || inRecord?.["command_line"] !== undefined || inRecord?.["CommandLine"] !== undefined)) {
    const cwd = getStringField(inRecord, "working_dir", "workingDir", "Cwd", "cwd", "dir");
    const shellOutput = extractShellOutput(output);
    const exitCode = extractExitCode(output);
    return {
      type: "shell",
      command,
      ...(cwd ? { cwd } : {}),
      ...(shellOutput !== undefined ? { output: shellOutput } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  // 2. Read / View file
  const isReadName =
    normName === "view_file" ||
    normName === "viewfile" ||
    normName === "read_file" ||
    normName === "readfile" ||
    normName === "cat" ||
    normName === "show_file" ||
    normName === "open_file" ||
    normName === "read_file_content";
  const readPath = getStringField(
    inRecord,
    "AbsolutePath",
    "TargetFile",
    "filePath",
    "file_path",
    "path",
    "file",
  );
  if (readPath && (isReadName || inRecord?.["StartLine"] !== undefined || inRecord?.["StartLine"] !== undefined)) {
    const offset = getNumberField(inRecord, "StartLine", "start_line", "offset", "line_offset");
    const endLine = getNumberField(inRecord, "EndLine", "end_line");
    const rawLimit = getNumberField(inRecord, "limit", "line_count");
    let limit: number | undefined = rawLimit;
    if (limit === undefined && endLine !== undefined) {
      limit = offset !== undefined && endLine >= offset ? endLine - offset + 1 : endLine;
    }
    let content: string | undefined;
    if (typeof output === "string") {
      content = output;
    } else if (output && typeof output === "object") {
      const outRecord = output as Record<string, unknown>;
      content = getStringField(outRecord, "content", "text", "file_content", "output");
    }
    return {
      type: "read",
      filePath: readPath,
      ...(content !== undefined ? { content } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  }

  // 3. Edit file content (replace_file_content, edit_file)
  const isEditName =
    normName === "replace_file_content" ||
    normName === "replacefilecontent" ||
    normName === "multi_replace_file_content" ||
    normName === "edit_file" ||
    normName === "editfile" ||
    normName === "patch_file" ||
    normName === "modify_file";
  const editPath = getStringField(
    inRecord,
    "TargetFile",
    "AbsolutePath",
    "filePath",
    "file_path",
    "path",
    "file",
  );
  const oldString = getAnyStringField(
    inRecord,
    "TargetContent",
    "target_content",
    "oldString",
    "old_string",
    "find",
    "search",
  );
  const newString = getAnyStringField(
    inRecord,
    "ReplacementContent",
    "replacement_content",
    "newString",
    "new_string",
    "replace",
  );
  if (editPath && (isEditName || (oldString !== undefined && newString !== undefined))) {
    const unifiedDiff =
      getAnyStringField(inRecord, "unifiedDiff", "diff", "patch") ||
      (output && typeof output === "object"
        ? getAnyStringField(output as Record<string, unknown>, "unifiedDiff", "diff", "patch")
        : undefined);
    return {
      type: "edit",
      filePath: editPath,
      ...(oldString !== undefined ? { oldString } : {}),
      ...(newString !== undefined ? { newString } : {}),
      ...(unifiedDiff !== undefined ? { unifiedDiff } : {}),
    };
  }

  // 4. Write to file
  const isWriteName =
    normName === "write_to_file" ||
    normName === "writetofile" ||
    normName === "write_file" ||
    normName === "writefile" ||
    normName === "create_file" ||
    normName === "save_file";
  const writePath = getStringField(
    inRecord,
    "TargetFile",
    "AbsolutePath",
    "filePath",
    "file_path",
    "path",
    "file",
  );
  const codeContent = getAnyStringField(
    inRecord,
    "CodeContent",
    "code_content",
    "content",
    "code",
    "text",
  );
  if (writePath && (isWriteName || codeContent !== undefined)) {
    return {
      type: "write",
      filePath: writePath,
      ...(codeContent !== undefined ? { content: codeContent } : {}),
    };
  }

  // 5. Search (search_web, grep, glob)
  const isSearchName =
    normName === "search_web" ||
    normName === "searchweb" ||
    normName === "web_search" ||
    normName === "google_search" ||
    normName === "grep" ||
    normName === "glob" ||
    normName === "find_files";
  const query = getStringField(inRecord, "query", "search_query", "pattern", "q");
  if (query && isSearchName) {
    const toolName =
      normName.includes("web") || normName.includes("google")
        ? "web_search"
        : normName === "grep"
          ? "grep"
          : normName === "glob"
            ? "glob"
            : "search";
    let content: string | undefined;
    let webResults: Array<{ title: string; url: string }> | undefined;
    if (typeof output === "string") {
      content = output;
    } else if (output && typeof output === "object") {
      const outRecord = output as Record<string, unknown>;
      content = getStringField(outRecord, "content", "summary", "text", "output");
      const rawResults = outRecord.results ?? outRecord.webResults;
      if (Array.isArray(rawResults)) {
        webResults = rawResults
          .filter(
            (r) =>
              r &&
              typeof r === "object" &&
              typeof (r as Record<string, unknown>).title === "string" &&
              typeof (r as Record<string, unknown>).url === "string",
          )
          .map((r) => ({
            title: String((r as Record<string, unknown>).title),
            url: String((r as Record<string, unknown>).url),
          }));
      }
    }
    return {
      type: "search",
      query,
      toolName,
      ...(content !== undefined ? { content } : {}),
      ...(webResults && webResults.length > 0 ? { webResults } : {}),
    };
  }

  // 6. Fetch / Browser (read_url_content, fetch_web_page)
  const isFetchName =
    normName === "read_url_content" ||
    normName === "readurlcontent" ||
    normName === "fetch_web_page" ||
    normName === "read_browser_page" ||
    normName === "web_fetch" ||
    normName === "fetch";
  const url = getStringField(inRecord, "Url", "url", "URL", "link");
  if (url && (isFetchName || inRecord?.["Url"] !== undefined || inRecord?.["url"] !== undefined)) {
    let result: string | undefined;
    if (typeof output === "string") {
      result = output;
    } else if (output && typeof output === "object") {
      const outRecord = output as Record<string, unknown>;
      result = getStringField(outRecord, "result", "content", "text", "output");
    }
    return {
      type: "fetch",
      url,
      ...(result !== undefined ? { result } : {}),
    };
  }

  // 7. Subagent (invoke_subagent)
  const isSubagentName =
    normName === "invoke_subagent" ||
    normName === "invokesubagent" ||
    normName === "spawn_subagent" ||
    normName === "subagent_spawn";
  const rawSubagents = inRecord?.Subagents ?? inRecord?.subagents;
  if (isSubagentName || Array.isArray(rawSubagents)) {
    const subagents = Array.isArray(rawSubagents) ? rawSubagents : [];
    const first =
      subagents[0] && typeof subagents[0] === "object"
        ? (subagents[0] as Record<string, unknown>)
        : null;
    const subAgentType = getStringField(first, "TypeName", "type_name", "Role", "role");
    const description = getStringField(first, "Prompt", "prompt", "initial_prompt");
    let log = "";
    if (typeof output === "string") {
      log = output;
    } else if (output && typeof output === "object") {
      log =
        getStringField(output as Record<string, unknown>, "log", "output", "summary") ??
        JSON.stringify(output, null, 2);
    }
    return {
      type: "sub_agent",
      ...(subAgentType ? { subAgentType } : {}),
      ...(description ? { description } : {}),
      log,
    };
  }

  // Default fallback
  return {
    type: "unknown",
    input: (input as any) ?? null,
    output: (output as any) ?? null,
  };
}

export function enrichToolCall(item: ToolCallTimelineItem): ToolCallTimelineItem {
  let detail = item.detail;
  if (detail?.type === "unknown") {
    detail = enrichToolCallDetail(item.name, detail.input, detail.output);
  }

  if (item.status === "failed" && item.error == null) {
    const fallbackOutput = (item.detail as any)?.output;
    const errorText =
      extractErrorText(fallbackOutput) ??
      (typeof fallbackOutput === "string" ? fallbackOutput : undefined) ??
      "Tool call failed";
    return {
      ...item,
      detail,
      error: errorText,
    };
  }

  return {
    ...item,
    detail,
  };
}
