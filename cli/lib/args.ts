export interface ParseSpec {
  flags: string[];                // boolean flags (e.g. ["json", "force"])
  values: string[];               // string-valued flags (e.g. ["port", "vault"])
  shortMap?: Record<string, string>; // e.g. { f: "follow", h: "help" }
}

export interface ParseResult {
  positional: string[];
  flags: Record<string, boolean>;
  values: Record<string, string>;
  help: boolean;
}

export function parseArgs(argv: string[], spec: ParseSpec): ParseResult {
  const result: ParseResult = {
    positional: [],
    flags: {},
    values: {},
    help: false,
  };
  const flagSet = new Set(spec.flags);
  const valSet = new Set(spec.values);
  const shortMap = spec.shortMap ?? {};

  let i = 0;
  let stopFlags = false;
  while (i < argv.length) {
    const a = argv[i];
    if (stopFlags) {
      result.positional.push(a);
      i++;
      continue;
    }
    if (a === "--") {
      stopFlags = true;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      result.help = true;
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (flagSet.has(key)) {
        result.flags[key] = true;
        i++;
        continue;
      }
      if (valSet.has(key)) {
        if (eq >= 0) {
          result.values[key] = a.slice(eq + 1);
          i++;
          continue;
        }
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`--${key} expects a value`);
        result.values[key] = v;
        i += 2;
        continue;
      }
      throw new Error(`unknown flag: --${key}`);
    }
    if (a.startsWith("-") && a.length === 2) {
      const long = shortMap[a[1]];
      if (long && flagSet.has(long)) {
        result.flags[long] = true;
        i++;
        continue;
      }
      throw new Error(`unknown flag: ${a}`);
    }
    result.positional.push(a);
    i++;
  }
  return result;
}
