/** Valid customer input for tests: "Jane Doe" -> first/last name, with a default mobile number. */
export function customerInput(name: string, extra: Record<string, unknown> = {}) {
  const [first = '', ...rest] = name.trim().split(/\s+/);
  const { phone, ...others } = extra as { phone?: string };
  return { firstName: first, lastName: rest.join(' ') || 'Tester', mobile: phone ?? '082 000 0000', ...others };
}
