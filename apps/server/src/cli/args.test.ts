import { describe, expect, test } from "bun:test";
import { pageUrl, parseUpArgs, UP_USAGE } from "./args.ts";

describe("parseUpArgs", () => {
  test("no flags takes a free port on both legs and opens a browser", () => {
    expect(parseUpArgs([])).toEqual({ apiPort: 0, tunnelPort: 0, open: true, help: false });
  });

  test("--api-port and --tunnel-port pin the two legs", () => {
    expect(parseUpArgs(["--api-port", "8080", "--tunnel-port", "8081"])).toEqual({
      apiPort: 8080,
      tunnelPort: 8081,
      open: true,
      help: false,
    });
  });

  test("--no-open leaves the browser alone", () => {
    expect(parseUpArgs(["--no-open"]).open).toBe(false);
  });

  test("an unknown flag is refused and named", () => {
    expect(() => parseUpArgs(["--port", "1"])).toThrow('unknown flag "--port"');
  });

  test("a value that is not a port is refused", () => {
    expect(() => parseUpArgs(["--api-port", "http"])).toThrow("--api-port needs an integer port");
    expect(() => parseUpArgs(["--tunnel-port"])).toThrow("--tunnel-port needs a port number");
  });

  test("--help is read without the rest of the line having to parse", () => {
    expect(parseUpArgs(["--help"]).help).toBe(true);
  });
});

describe("pageUrl", () => {
  test("the operator token rides the fragment, which no browser sends to a server", () => {
    expect(pageUrl(51234, "tok")).toBe("http://127.0.0.1:51234/#token=tok");
  });
});

describe("UP_USAGE", () => {
  test("names the command and every flag, so --help is the whole contract", () => {
    for (const flag of ["--no-open", "--api-port", "--tunnel-port", "-h, --help"]) {
      expect(UP_USAGE).toContain(flag);
    }
    expect(UP_USAGE.split("\n")[0]).toBe("usage: bun run up [flags]");
  });
});
