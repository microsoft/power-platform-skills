export async function powerPagesFetch<T>(path: string): Promise<T> {
  const token = await new Promise<string>((resolve, reject) => {
    window.shell.getTokenDeferred().done(resolve).fail(reject);
  });
  const response = await fetch(`/_api/${path}`, {
    headers: {
      Accept: 'application/json',
      '__RequestVerificationToken': token,
    },
  });
  if (!response.ok) throw new Error(`Power Pages API request failed: ${response.status}`);
  return response.json() as Promise<T>;
}
