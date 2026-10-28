export interface WebBriefConfig {
  runnerToken: string;
  readerToken: string;
  adminToken: string;
}

export function loadWebBriefConfig(env: NodeJS.ProcessEnv = process.env): WebBriefConfig | null {
  const values = [env.WEB_BRIEF_RUNNER_TOKEN, env.WEB_BRIEF_READER_TOKEN, env.WEB_BRIEF_ADMIN_TOKEN];
  if (values.every((value) => value === undefined || value === "")) return null;
  if (values.some((value) => value === undefined || Buffer.byteLength(value) < 32 || /\s/u.test(value))) {
    throw new Error("Web brief requires three distinct whitespace-free tokens of at least 32 bytes");
  }
  const [runnerToken, readerToken, adminToken] = values;
  if (runnerToken === undefined || readerToken === undefined || adminToken === undefined || new Set(values).size !== 3) {
    throw new Error("Web brief tokens must be distinct");
  }
  return { runnerToken, readerToken, adminToken };
}
