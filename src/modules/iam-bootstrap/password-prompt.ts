import { closeSync, openSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { ReadStream } from 'node:tty';

/**
 * CR-HM-IAM-BOOTSTRAP-01 — interactive, no-echo password input.
 *
 * The owner password is read directly from the controlling terminal
 * (`/dev/tty`), never from argv, stdin redirection or an environment
 * variable. Raw mode disables terminal echo, so the password is not displayed
 * and does not enter shell history. Every control path writes only static
 * prompts/messages — the captured value is never echoed, logged or included in
 * an error.
 *
 * If no controlling terminal is available the command fails closed instead of
 * falling back to a non-interactive source.
 */
export class InteractivePasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InteractivePasswordError';
  }
}

const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const DELETE = 127;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

function writeTerminal(fd: number, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    // Terminal write failures must not leak or block the security flow.
  }
}

/**
 * Reads one line from the controlling terminal with echo disabled.
 * The terminating newline is written by us (echo is off), keeping the
 * terminal layout intact without revealing the typed characters.
 */
export async function readSecretFromTerminal(prompt: string): Promise<string> {
  let inputFd: number;
  let outputFd: number;

  try {
    inputFd = openSync('/dev/tty', 'r');
  } catch {
    throw new InteractivePasswordError(
      'No interactive terminal is available. Run this command from an interactive terminal; passwords are never accepted through arguments, pipes or environment variables.',
    );
  }

  try {
    outputFd = openSync('/dev/tty', 'w');
  } catch {
    closeSync(inputFd);
    throw new InteractivePasswordError(
      'No interactive terminal is available. Run this command from an interactive terminal; passwords are never accepted through arguments, pipes or environment variables.',
    );
  }

  const stream = new ReadStream(inputFd);
  stream.setRawMode(true);
  stream.resume();

  writeTerminal(outputFd, prompt);

  return new Promise<string>((resolve, reject) => {
    let value = '';
    let settled = false;
    const decoder = new StringDecoder('utf8');

    const finish = (outcome: 'resolve' | 'reject', result?: string, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;

      writeTerminal(outputFd, '\n');

      stream.removeAllListeners('data');
      stream.removeAllListeners('error');
      stream.removeAllListeners('end');
      try {
        stream.setRawMode(false);
      } catch {
        // Stream may already be closing.
      }
      try {
        stream.pause();
      } catch {
        // Stream may already be closing.
      }
      try {
        stream.destroy();
      } catch {
        // Stream may already be closing.
      }
      try {
        closeSync(outputFd);
      } catch {
        // Already closed.
      }

      if (outcome === 'resolve') {
        resolve(result ?? '');
      } else {
        reject(error ?? new InteractivePasswordError('Password input aborted.'));
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      const text =
        typeof chunk === 'string' ? chunk : decoder.write(chunk);

      for (const character of text) {
        const codePoint = character.codePointAt(0) ?? 0;

        if (codePoint === CTRL_C || codePoint === CTRL_D) {
          finish(
            'reject',
            undefined,
            new InteractivePasswordError('Password input aborted.'),
          );
          return;
        }

        if (codePoint === CARRIAGE_RETURN || codePoint === LINE_FEED) {
          finish('resolve', value);
          return;
        }

        if (codePoint === BACKSPACE || codePoint === DELETE) {
          value = [...value].slice(0, -1).join('');
          continue;
        }

        // Ignore other terminal control characters (arrow keys, etc.); never
        // interpret them as part of the secret.
        if (codePoint < 32) {
          continue;
        }

        value += character;
      }
    });

    stream.once('error', () => {
      finish(
        'reject',
        undefined,
        new InteractivePasswordError('The terminal could not be read.'),
      );
    });

    stream.once('end', () => {
      finish(
        'reject',
        undefined,
        new InteractivePasswordError('Password input was interrupted.'),
      );
    });
  });
}

function describeValidationFailure(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { details?: unknown }).details;
    if (Array.isArray(details) && details.length > 0) {
      return details
        .map((detail) => {
          if (detail && typeof detail === 'object' && 'message' in detail) {
            return String((detail as { message: unknown }).message);
          }
          return String(detail);
        })
        .join(' ');
    }
    return error.message;
  }
  return 'The password was rejected by the password policy.';
}

/**
 * Prompts for a new password twice and validates it with the supplied policy
 * function (the existing `passwordService.validatePassword`). Up to three
 * attempts are allowed; the password itself is never written anywhere.
 */
export async function promptForNewPassword(
  validate: (candidate: string) => void,
  maxAttempts = 3,
): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const first = await readSecretFromTerminal(
      'First-owner password (input hidden): ',
    );
    const confirmation = await readSecretFromTerminal(
      'Confirm first-owner password (input hidden): ',
    );

    if (first !== confirmation) {
      process.stderr.write('Passwords do not match. Please try again.\n');
      continue;
    }

    try {
      validate(first);
      return first;
    } catch (error) {
      process.stderr.write(
        `Password rejected: ${describeValidationFailure(error)}\n`,
      );
    }
  }

  throw new InteractivePasswordError(
    'Password entry failed too many times. No account was created.',
  );
}
