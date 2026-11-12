import React from "react";
import { copy } from "../lib/copy";

export function OpenSyncPage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6 py-10">
      <h1 className="text-xl font-semibold text-oai-gray-900 dark:text-oai-gray-100">{copy("open.sync.title")}</h1>
      <p className="mt-3 text-sm leading-6 text-oai-gray-700 dark:text-oai-gray-300">{copy("open.sync.body")}</p>
      <pre className="mt-4 overflow-auto rounded-md bg-oai-gray-100 p-3 text-xs text-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-200">{copy("open.sync.command")}</pre>
    </main>
  );
}
