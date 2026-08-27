"use client";
import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@/context/UserContext";
import { logout } from "@/utils/userUtils";
import { Squash } from "hamburger-react";
import { NavItem } from "@/components/layout/navbar/NavItem";
import NeiistLogo from "@/components/layout/navbar/NeiistLogo";
import ShoppingCart from "@/components/layout/navbar/ShoppingCart";
import LoginButton from "@/components/layout/navbar/LoginButton";
import LoginModal from "@/components/layout/navbar/LoginModal";
import UserMenu from "@/components/layout/navbar/UserMenu";
import { ThemeToggle } from "@/components/layout/navbar/ThemeToggle";
import styles from "@/styles/components/layout/navbar/NavBar.module.css";

const navLinks = [
  { name: "Sobre Nós", href: "/about-us" },
  { name: "Atividades", href: "/activities" },
  /*{ name: "Blog", href: "/blog" },*/
  { name: "Loja", href: "/shop" },
  { name: "Jantar de Curso", href: "/dinner" },
];

export default function NavBar() {
  const router = useRouter();
  const { user, setUser } = useUser();
  const [isSticky, setIsSticky] = useState(false);
  const [menuState, setMenuState] = useState<"closed" | "open" | "closing">("closed");
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setIsSticky(window.scrollY > 0);
    window.addEventListener("scroll", onScroll);
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (menuState !== "open") return;
    const handleClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) closeMenu();
    };
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 100);
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [menuState]);

  const toggleMenu = () => {
    if (menuState === "open" || menuState === "closing") {
      closeMenu();
    } else {
      setMenuState("open");
    }
  };

  const closeMenu = () => {
    setMenuState("closing");
    setTimeout(() => setMenuState("closed"), 300);
  };

  const handleMobileNavClick = (href: string) => {
    closeMenu();
    setTimeout(() => {
      router.push(href);
    }, 300);
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  /**
   * Members get one extra link: the workspace.
   *
   * The test is `teams.length > 0`, not "is logged in" — the same rule as `isNeiistMember` on the
   * server (#183). A Técnico student who bought a t-shirt authenticates fine and belongs to no
   * team, and showing them a link that redirects to /unauthorized is worse than not showing it.
   *
   * This only decides what the NAVBAR offers. The boundary is `requireNeiistMember` in the
   * workspace layout and `requireTeamWorkspace` on each team page; a wrong answer here is a
   * missing link, never access.
   */
  const isMember = (user?.teams?.length ?? 0) > 0;
  const visibleLinks = isMember
    ? [...navLinks, { name: "Espaço de Trabalho", href: "/workspace" }]
    : navLinks;

  const renderNavItems = (onClick?: (_href: string) => void) => {
    return visibleLinks.map((link) => (
      <NavItem
        key={link.name}
        href={link.href}
        label={link.name}
        onClick={onClick ? () => onClick(link.href) : undefined}
      />
    ));
  };

  return (
    <header className={`${styles.header} ${isSticky ? styles.sticky : ""}`}>
      <nav className={styles.navigation}>
        <Link href="/" className={styles.logo}>
          <NeiistLogo />
        </Link>
        <div className={styles.navItems}>{renderNavItems()}</div>
      </nav>
      <div className={styles.actions}>
        <ThemeToggle />
        <ShoppingCart />
        {user ? (
          <UserMenu userData={user} logout={handleLogout} />
        ) : (
          <LoginButton onClick={() => setIsLoginModalOpen(true)} />
        )}
        <LoginModal isOpen={isLoginModalOpen} onClose={() => setIsLoginModalOpen(false)} />
        <div className={styles.menuButton}>
          <Squash
            toggled={menuState === "open"}
            toggle={toggleMenu}
            size={24}
            color="var(--foreground-colour)"
            rounded
          />
        </div>
      </div>
      {(menuState === "open" || menuState === "closing") && (
        <div
          ref={menuRef}
          className={`${styles.menu} ${menuState === "closing" ? styles.slideOut : ""}`}>
          <Link href="/" className={styles.logo} onClick={() => handleMobileNavClick("/")}>
            <NeiistLogo />
          </Link>
          <nav className={styles.navItems}>{renderNavItems(handleMobileNavClick)}</nav>
        </div>
      )}
    </header>
  );
}
