import Markdown from 'react-markdown';

export default function SafeMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      skipHtml
      components={{
        img: ({ alt }) => <span className="remote-image">[外部图片未加载：{alt || '图片'}]</span>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
