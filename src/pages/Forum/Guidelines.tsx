import { Helmet } from "react-helmet-async";
import ForumLayout from "./ForumLayout";

export default function Guidelines() {
  return (
    <ForumLayout>
      <Helmet>
        <title>Community Guidelines — Elite Swap Forum</title>
        <meta name="description" content="Rules for keeping the Elite Swap community safe and helpful." />
      </Helmet>
      <article className="prose prose-invert max-w-none">
        <h1 className="text-3xl font-heading font-bold gradient-text">Community Guidelines</h1>
        <p className="text-muted-foreground">
          This forum exists so Elite Swap users can help each other. Keep it safe and supportive.
        </p>
        <h2>Be respectful</h2>
        <p>No harassment, hate speech, or personal attacks. Disagree with ideas, not people.</p>
        <h2>Stay on topic</h2>
        <p>Post in the right category. Search before starting a new thread.</p>
        <h2>No spam or self-promo</h2>
        <p>Don't post affiliate links, sales pitches, or unrelated promotions.</p>
        <h2>Protect privacy</h2>
        <p>Don't share other people's personal info, unique keys, or payment details.</p>
        <h2>Voice notes &amp; images</h2>
        <p>
          All media is held for quick admin review before becoming public. Keep it appropriate —
          inappropriate content will be rejected and may result in a ban.
        </p>
        <h2>Reporting</h2>
        <p>
          Use the report button on any post that breaks these rules. Three open reports auto-hide
          a post pending review.
        </p>
      </article>
    </ForumLayout>
  );
}
