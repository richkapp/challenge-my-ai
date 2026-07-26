export function runLocalJob<T>(work: () => T): T {
  return work();
}
