export function triggerDevConfigured() {
  return Boolean(process.env.TRIGGER_SECRET_KEY);
}
