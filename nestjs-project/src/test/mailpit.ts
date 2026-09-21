const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

export interface MailpitAddress {
  Name: string;
  Address: string;
}

/** A message as listed by `GET /api/v1/messages`. */
export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: MailpitAddress[];
  From: MailpitAddress;
}

/** A single message as returned by `GET /api/v1/message/{id}`. */
export interface MailpitMessageDetail extends MailpitMessage {
  HTML: string;
  Text: string;
}

export async function getMailpitMessages(): Promise<MailpitMessage[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessage[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(
  id: string,
): Promise<MailpitMessageDetail> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessageDetail;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
