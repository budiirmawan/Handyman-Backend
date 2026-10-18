/**
 * CR-HM-IAM-BOOTSTRAP-01 — strict argv parsing for the operator CLI.
 *
 * Only non-secret identity fields are accepted. `--password` is rejected with
 * an explicit message so a well-meaning operator cannot leak the secret into
 * shell history, process listings or CI logs. The password is read later from
 * the controlling terminal with echo disabled.
 */
export const BOOTSTRAP_OWNER_USAGE =
  'node dist/database/cli.js bootstrap-owner --email <email> --display-name <name>';

export type BootstrapOwnerArgs = {
  email: string;
  displayName: string;
};

export function parseBootstrapOwnerArgs(
  argv: string[],
): BootstrapOwnerArgs {
  let email = '';
  let displayName = '';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--email') {
      email = argv[index + 1] ?? '';
      index += 1;
    } else if (argument.startsWith('--email=')) {
      email = argument.slice('--email='.length);
    } else if (argument === '--display-name') {
      displayName = argv[index + 1] ?? '';
      index += 1;
    } else if (argument.startsWith('--display-name=')) {
      displayName = argument.slice('--display-name='.length);
    } else if (
      argument === '--password' ||
      argument.startsWith('--password=')
    ) {
      throw new Error(
        'Passwords must never be supplied as command-line arguments. Run the command interactively; the password is read from the terminal with echo disabled.',
      );
    } else if (argument === '--help' || argument === '-h') {
      throw new Error(`Usage: ${BOOTSTRAP_OWNER_USAGE}`);
    } else {
      throw new Error(
        `Unknown argument: ${argument}. Usage: ${BOOTSTRAP_OWNER_USAGE}`,
      );
    }
  }

  if (email.trim() === '' || displayName.trim() === '') {
    throw new Error(
      `Both --email and --display-name are required. Usage: ${BOOTSTRAP_OWNER_USAGE}`,
    );
  }

  return { email: email.trim(), displayName: displayName.trim() };
}
