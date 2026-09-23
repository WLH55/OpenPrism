// 消息正文的 markdown 渲染：GFM（表格/任务列表/删除线/自动链接）+ 保留单换行。
// 原始 HTML 不解析（未接 rehype-raw），链接协议由 react-markdown 默认白名单过滤。
// 样式只用主题 token，浅色与深色两套变量下同时成立。

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  h1: ({ node: _node, ...props }) => <h1 className="mb-2 mt-4 text-[17px] font-semibold first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mb-2 mt-4 text-[16px] font-semibold first:mt-0" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mb-1.5 mt-3 text-[15px] font-semibold first:mt-0" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mb-1.5 mt-3 text-[15px] font-semibold text-ink2 first:mt-0" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mb-1 mt-2 text-[14px] font-semibold text-ink2 first:mt-0" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mb-1 mt-2 text-[14px] font-semibold text-ink3 first:mt-0" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0" {...props} />,
  li: ({ node: _node, className, ...props }) => (
    <li
      className={`leading-relaxed [&>ol]:my-1 [&>ul]:my-1 ${className?.includes("task-list-item") ? "list-none" : ""} ${className ?? ""}`}
      {...props}
    />
  ),
  strong: ({ node: _node, ...props }) => <strong className="font-semibold" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
  del: ({ node: _node, ...props }) => <del className="line-through opacity-70" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 border-accent bg-accent3/40 px-3 py-1.5 text-ink2" {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-line" {...props} />,
  pre: ({ node: _node, ...props }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-surface p-3 text-[13px] leading-relaxed" {...props} />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={`font-mono ${className?.includes("language-") ? "text-[13px]" : "rounded bg-surface px-1 py-0.5 text-[13px] text-accent2"}`}
      {...props}
    />
  ),
  a: ({ node: _node, ...props }) => <a className="text-accent underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
  img: ({ node: _node, ...props }) => <img className="my-2 max-h-64 max-w-full rounded-lg" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[14px]" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border border-line bg-surface px-2 py-1 text-left font-medium" {...props} />
  ),
  td: ({ node: _node, ...props }) => <td className="border border-line px-2 py-1 align-top" {...props} />,
  input: ({ node: _node, ...props }) => <input className="mr-1.5 accent-[var(--accent)]" {...props} />,
};

/** 把一段 markdown 正文渲染成结构化 HTML（标题/列表/加粗/代码/表格/引用） */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
