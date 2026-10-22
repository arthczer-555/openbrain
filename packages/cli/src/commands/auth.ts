import { hashCode } from "@openbrain/server";
import type { ParsedArgs } from "../args.ts";
import { bold, dim } from "./shared.ts";
import type { CommandDefinition } from "./types.ts";

// openbrain auth hash-code [code]: the value to put in ACCESS_CODE_HASH or ADMIN_CODE_HASH (PBKDF2-SHA256).
// Without a code, one is generated. Only the hash goes to Netlify; the code is shared by hand.

export const authCommand: CommandDefinition = {
  name: "auth",
  help: "auth hash-code [<code>]    Hash an access code for ACCESS_CODE_HASH / ADMIN_CODE_HASH",
  async run(args: ParsedArgs): Promise<number> {
    if (args.positionals[1] !== "hash-code") {
      console.log("usage: openbrain auth hash-code [<code>]");
      return 1;
    }
    const given = args.positionals[2];
    const code = given ?? [...crypto.getRandomValues(new Uint8Array(9))].map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
    if (code.length < 8) {
      console.log("use at least 8 characters");
      return 1;
    }
    const hash = await hashCode(code);
    if (!given) console.log(`code: ${bold(code)}`);
    console.log(`hash: ${hash}`);
    console.log(dim("Put the hash in the Netlify environment (ACCESS_CODE_HASH or ADMIN_CODE_HASH), never the code."));
    return 0;
  },
};
