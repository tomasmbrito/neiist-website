import styles from "@/styles/components/about-us/JoinUs.module.css";

export default function JoinUs() {
  // #134. This pointed at https://google.com — a placeholder that shipped. The application form
  // now exists on the site.
  const joinUsLink = "/candidatura";

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Junta-te a nós!</h3>
      <p className={styles.descprition}>
        O nosso recrutamento acontece duas vezes por ano, no inicio de cada semestre. O recrutamento
        consiste de uma ronda de entrevistas, e para algumas equipas um pequeno desafio relacionado
        com o trabalho da equipa espesífica. Conta-mos contigo!
      </p>
      <a href={joinUsLink} target="_blank" rel="noopener noreferrer" className={styles.apply}>
        Candidata-te
      </a>
    </div>
  );
}
