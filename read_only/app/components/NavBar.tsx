"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./NavBar.module.css";

const NAV_ITEMS = [
  { href: "/", label: "Softwares" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${active ? styles.active : ""}`.trim()}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
