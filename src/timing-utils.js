export function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

export function elapsedMs(startMs) {
  return nowMs() - startMs;
}

export function formatDuration(ms) {
  return `${ms}ms`;
}

export async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
