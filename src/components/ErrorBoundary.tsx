import { Component, ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[ErrorBoundary]", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="glass neon-border rounded-2xl p-8 max-w-md w-full text-center space-y-4">
            <h1 className="text-2xl font-heading font-bold text-destructive">
              {this.props.fallbackTitle ?? "Something went wrong"}
            </h1>
            <p className="text-sm text-muted-foreground break-words">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={this.handleReset} className="font-heading text-xs">
                Try again
              </Button>
              <Button variant="outline" onClick={() => window.location.assign("/")} className="font-heading text-xs">
                Go home
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
