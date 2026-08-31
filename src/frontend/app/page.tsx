import Link from "next/link";
import styles from "./home.module.css";

export default function HomePage() {
  return (
    <main className={styles.main}>
      <p className={styles.eyebrow}>FloorSync · Foundation</p>
      <h1 className={styles.hero}>Application foundation.</h1>
      <p className={styles.intro}>The frontend, API, worker and local development environment are ready for the team’s next decisions.</p>
      <section className={styles.grid}>
        <article className={styles.card}><h2 className={styles.cardTitle}>Frontend shell</h2><p>Next.js and TypeScript are configured.</p><span className={styles.cardTag}>Feature design to follow</span></article>
        <article className={styles.card}><h2 className={styles.cardTitle}>API health</h2><p>FastAPI exposes a health check for local verification.</p><span className={styles.cardTag}>Routes to follow</span></article>
      </section>
      <section className={styles.grid}>
        <article className={styles.card}>
          <Link className={styles.cardLink} href="/manager"><h2 className={styles.cardTitle}>Manager dashboard</h2></Link>
          <p>Facility overview, utilisation, job progress and anomalies.</p>
          <span className={styles.cardTag}>Mock UI · frontend only</span>
        </article>
        <article className={styles.card}>
          <Link className={styles.cardLink} href="/operator"><h2 className={styles.cardTitle}>Operator dashboard</h2></Link>
          <p>Machine queue, current operation and live status.</p>
          <span className={styles.cardTag}>Mock UI · frontend only</span>
        </article>
      </section>
    </main>
  );
}
