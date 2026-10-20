import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ReleaseNotesMarkdown({ notes }: { notes: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>;
}
