import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * A render error used to unmount the whole tree (white screen). Catch it and
 * offer recovery instead, keeping the app usable after a bad message.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("render error", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-foreground">
          <p className="font-medium text-sm">界面渲染出错了</p>
          <pre className="max-h-40 max-w-xl overflow-auto rounded-md border bg-muted p-3 font-mono text-[11px] text-muted-foreground">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <Button onClick={() => this.setState({ error: null })} size="sm" variant="outline">
              重试渲染
            </Button>
            <Button onClick={() => window.location.reload()} size="sm">
              重新加载
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
