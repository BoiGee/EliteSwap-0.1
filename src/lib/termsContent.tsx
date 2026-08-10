export const TERMS_VERSION = "2026-06-01";

export function TermsContent() {
  return (
    <div className="space-y-5 text-sm text-foreground/80 font-body leading-relaxed">
      <section>
        <h3 className="font-heading font-semibold text-foreground mb-1">1. Terms of Service</h3>
        <p>
          By using Elite Swap you agree to use the studio for lawful purposes only. We may suspend or
          terminate access if these terms are violated. The service is provided "as is" without
          warranties of any kind. You are solely responsible for the content you create, distribute,
          or display using the platform.
        </p>
      </section>

      <section>
        <h3 className="font-heading font-semibold text-foreground mb-1">2. Privacy</h3>
        <p>
          We collect the minimum data needed to operate your account: email, usage metrics, device
          signals (to prevent free-trial abuse), and payment records. We never sell your data. You can
          request deletion at any time by contacting support.
        </p>
      </section>

      <section>
        <h3 className="font-heading font-semibold text-foreground mb-1">3. Responsible Use Policy</h3>
        <p className="mb-2">
          Elite Swap provides real-time face-swap technology. You agree that you will <strong>NOT</strong> use
          the studio to:
        </p>
        <ul className="list-disc list-inside space-y-1 pl-2">
          <li>Create content depicting any person without their explicit consent.</li>
          <li>Generate sexual, intimate, or nude content involving real people.</li>
          <li>Produce any content involving minors.</li>
          <li>Impersonate others for fraud, harassment, defamation, or political manipulation.</li>
          <li>Create content that violates any applicable law in your jurisdiction.</li>
          <li>Mislead viewers in contexts where authenticity is expected (news, evidence, identity verification).</li>
        </ul>
      </section>

      <section>
        <h3 className="font-heading font-semibold text-foreground mb-1">4. Your Responsibility</h3>
        <p>
          You accept full legal and ethical responsibility for any content you produce. Elite Swap
          provides the tool; how it is used is your obligation. Violations may result in immediate
          termination and, where applicable, referral to law enforcement.
        </p>
      </section>

      <p className="text-xs text-muted-foreground pt-2 border-t border-border/40">
        Version {TERMS_VERSION}
      </p>
    </div>
  );
}
