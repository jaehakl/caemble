"use client";

import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Hello World</h1>
      <p>
        <Link href="/new-softwares-batch">Go to New Softwares Batch</Link>
      </p>
    </main>
  );
}
