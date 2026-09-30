// Consent gate for the capture flow. Renders once per capture session,
// records the acknowledgement into `capture_consents` on the server, and
// stores a short "already consented for capture X" flag in sessionStorage
// so a route re-render doesn't ask the user twice.
//
// The consent text intentionally names what the app does with the data
// (server-side VLM analysis, storage in the user's Supabase project) —
// changing the text should bump `CONSENT_VERSION` so a returning user
// re-acknowledges the new terms.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

export const CONSENT_VERSION = "capture-v1";

const consentKey = (captureId: string) => `sqnr:consent:${captureId}`;

export function hasLocalConsent(captureId: string): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(consentKey(captureId)) === CONSENT_VERSION;
}

export function persistLocalConsent(captureId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(consentKey(captureId), CONSENT_VERSION);
}

export interface CaptureConsentProps {
  onAccept: () => void;
}

export function CaptureConsent({ onAccept }: CaptureConsentProps) {
  const [ackRecord, setAckRecord] = useState(false);
  const [ackShare, setAckShare] = useState(false);

  const ready = ackRecord && ackShare;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Before you start scanning</CardTitle>
        <CardDescription>
          You&apos;re about to capture photos and audio of a physical space.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">
          SQNR uses your camera and microphone to reconstruct the room. Photos and one short sonic
          ping are uploaded to your account for on-device and AI-assisted analysis. No frames leave
          your Supabase project except when your chosen AI provider processes them.
        </p>
        <label className="flex items-start gap-2">
          <Checkbox
            checked={ackRecord}
            onCheckedChange={(v) => setAckRecord(v === true)}
            aria-label="Acknowledge recording"
          />
          <span>
            I am recording a space I have permission to record. Anyone visible in frame has
            consented, or I will delete their frames before sharing.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <Checkbox
            checked={ackShare}
            onCheckedChange={(v) => setAckShare(v === true)}
            aria-label="Acknowledge processing"
          />
          <span>
            I understand my capture will be uploaded and processed by an AI provider (Claude or a
            self-hosted model) to reconstruct the room.
          </span>
        </label>
        <Button className="w-full" disabled={!ready} onClick={onAccept}>
          Start capture
        </Button>
      </CardContent>
    </Card>
  );
}
