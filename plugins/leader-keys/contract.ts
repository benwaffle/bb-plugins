import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  keymap: {
    input: z.null(),
    output: z.object({
      path: z.string(),
      text: z.string().nullable(),
    }),
  },
});
