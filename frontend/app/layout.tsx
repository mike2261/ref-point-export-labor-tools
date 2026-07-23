import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Điểm thưởng CTV | Hệ thống XKLĐ",
  description: "Đăng nhập và quản lý tài khoản cộng tác viên XKLĐ.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
