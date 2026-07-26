export function createMockCheckoutUrl(kind: string) {
  return `/dashboard?checkout=mock-${kind}`;
}
