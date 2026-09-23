// Reading a `--name value` flag off the command line. Shared by every verb, wherever it lives.
export const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
