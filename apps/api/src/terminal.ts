import * as readline from "node:readline";

export async function requireTtyPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("This command requires a controlling TTY.");
  return await new Promise<string>((resolve, reject) => {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = process.stdout;
    const originalWrite = output.write.bind(output);
    originalWrite(prompt);
    output.write = ((value: string | Uint8Array) => originalWrite(typeof value === "string" ? "*" : value)) as typeof output.write;
    terminal.question("", (value) => {
      output.write = originalWrite;
      originalWrite("\n");
      terminal.close();
      resolve(value);
    });
    terminal.once("SIGINT", () => { terminal.close(); reject(new Error("Cancelled.")); });
  });
}
