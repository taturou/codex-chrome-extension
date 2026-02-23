import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

interface SafeMarkdownProps {
  markdown: string;
}

export function SafeMarkdown({ markdown }: SafeMarkdownProps): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
      {markdown}
    </ReactMarkdown>
  );
}
