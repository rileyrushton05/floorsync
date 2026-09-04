import Link from "next/link";
import styles from "./home.module.css";

export default function HomePage() {
  return (
    <main className={styles.main}>
      <p className={styles.eyebrow}>FloorSync · Foundation</p>
      <h1 className={styles.hero}>Application foundation.</h1>
      <p className={styles.intro}>The frontend, API, worker and local development environment are ready for the team’s next decisions.</p>
      <section className={styles.grid}>
        <article className={styles.card}>
          <Link className={styles.cardLink} href="/manager"><h2 className={styles.cardTitle}>Manager overview</h2></Link>
          <p>Facility-wide KPIs, job progress and machine status.</p>
          <span className={styles.cardTag}>Mock UI · frontend only</span>
        </article>
        <article className={styles.card}>
          <Link className={styles.cardLink} href="/manager/jobs"><h2 className={styles.cardTitle}>Jobs</h2></Link>
          <p>Define jobs, their operations and the dependencies between them.</p>
          <span className={styles.cardTag}>Feeds the scheduler</span>
        </article>
      </section>
      <section className={styles.grid}>
        <article className={styles.card}>
          <Link className={styles.cardLink} href="/manager/scheduler"><h2 className={styles.cardTitle}>Scheduler</h2></Link>
          <p>Release jobs and generate a plan from their dependencies and machine load.</p>
          <span className={styles.cardTag}>Plan · not clock-driven</span>
        </article>
        <article className={styles.card}>
          <Link className={styles.cardLink} href="/manager/simulation"><h2 className={styles.cardTitle}>Simulation</h2></Link>
          <p>Run a generated plan forward and watch the shop floor move through it.</p>
          <span className={styles.cardTag}>Playback of a plan</span>
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
