import React, { useEffect, useRef } from "react";
import { LuX, LuLogIn } from "react-icons/lu";
import { FcGoogle } from "react-icons/fc";
import styles from "@/styles/components/layout/navbar/LoginModal.module.css";
import { login, googleLogin } from "@/utils/userUtils";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose }) => {
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalContent} ref={modalRef}>
        <button className={styles.closeButton} onClick={onClose}>
          <LuX />
        </button>
        <h2 className={styles.title}>Login</h2>
        <p className={styles.subtitle}>Choose your login method</p>
        <div className={styles.buttonContainer}>
          <button className={styles.fenixButton} onClick={login}>
            <LuLogIn className={styles.icon} /> Sign in with Fenix
          </button>
          <button className={styles.googleButton} onClick={googleLogin}>
            <FcGoogle className={styles.icon} /> Sign in with Google
          </button>
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
