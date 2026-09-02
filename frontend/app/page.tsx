import { CallApp } from "@/components/call-app";

export default async function Home({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  const room = (await searchParams).room ?? "";
  return (
    <CallApp
      initialRoom={/^[A-Za-z0-9_-]{8,32}$/.test(room) ? room : ""}
      signalUrl={process.env.SIGNAL_URL ?? "http://localhost:8787"}
      turn={process.env.TURN_URL ? {
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      } : undefined}
    />
  );
}
