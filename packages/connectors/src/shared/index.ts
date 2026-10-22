// Public surface of the shared input helpers (low-level markup and date helpers stay internal).
export {
  hasDocuments,
  hasStream,
  isSkip,
  ReadOnlyViolationError,
  SkipItemError,
  type ConnectorManifest,
  type DocumentsConnector,
  type InputConnector,
  type InputTransport,
  type ManifestEnvVar,
  type SkippedItem,
  type StreamConnector,
} from "./types.ts";
export { HttpStatusError, parseRetryAfter, ReadOnlyHttp, withRetry, type ReadOnlyHttpOptions, type RetryOptions } from "./http.ts";
export { globFilter, globToRegExp, matchAnyGlob, matchGlob } from "./glob.ts";
export {
  firstJsonPath,
  parseJsonPath,
  queryJsonPath,
  renderTemplate,
  resolveMappingValue,
  stringifyValue,
  type JsonPathSegment,
} from "./jsonpath.ts";
export { htmlToMarkdown, parseHtml, type HtmlConversion, type HtmlToMarkdownOptions } from "./html.ts";
export { readZip, ZipFormatError, type ZipArchive, type ZipEntry, type ZipOptions } from "./zip.ts";
export { docxToMarkdown, pptxToMarkdown } from "./office.ts";
export { csvToMarkdown, DEFAULT_MAX_TABLE_ROWS, parseCsv, type CsvTable } from "./csv.ts";
export {
  detectSensitive,
  ibanValid,
  luhnValid,
  mergeFindingCounts,
  nirValid,
  summarizeFindings,
  type SensitiveCategory,
  type SensitiveFinding,
  type SensitiveKind,
} from "./sensitive.ts";
export { interpolateEnv, isEnvSet, loadDotEnv, referencedEnv, type EnvMap } from "./env.ts";
export {
  ApiInputSchema,
  CLAUDE_MANIFEST,
  ClaudeInputSchema,
  describeInputs,
  FilesInputSchema,
  GdriveInputSchema,
  GithubInputSchema,
  INPUT_MANIFESTS,
  inputDir,
  InputsConfigSchema,
  McpInputSchema,
  parseInputsConfig,
  WebInputSchema,
  type ApiInput,
  type BuildInputsOptions,
  type ClaudeInput,
  type EnvStatus,
  type FilesInput,
  type GdriveInput,
  type GithubInput,
  type InputEntry,
  type InputsConfig,
  type McpInput,
  type WebInput,
} from "./inputs.ts";
export {
  collectInputs,
  DEFAULT_WINDOW_DAYS,
  OPENBRAIN_DIR,
  renderDocumentFile,
  renderEventsFile,
  resolveCollectWindow,
  resolveOutDir,
  SYNC_STATE_FILE,
  type CollectedFile,
  type CollectInput,
  type CollectManifest,
  type CollectOptions,
  type CollectWindow,
  type ConnectorCollectReport,
} from "./collect.ts";
