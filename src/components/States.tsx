export function LoadingBlock({ label = "Loading sourced bank data" }: { label?: string }) {
  return <div className="loading" role="status" aria-live="polite"><span className="skeleton" />{label}...</div>;
}

export function ErrorState({ title = "Something went wrong", message, action }: { title?: string; message: string; action?: React.ReactNode }) {
  return <div className="notice error" role="alert"><b>{title}</b><p>{message}</p>{action}</div>;
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: React.ReactNode }) {
  return <div className="notice"><b>{title}</b><p>{message}</p>{action}</div>;
}
