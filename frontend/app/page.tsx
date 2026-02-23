"use client";

import React, { useEffect, useRef, useState } from "react";

/* ═══════════════════════════════════════════════════════════════════════════════
   INFYND — AI-Powered Multi-Channel Campaign Engine
   High-converting product landing page
   ═══════════════════════════════════════════════════════════════════════════════ */

// ─── Intersection Observer hook for scroll-triggered animations ──────────────
function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

// ─── Animated counter ────────────────────────────────────────────────────────
function Counter({ end, suffix = "", duration = 2000 }: { end: number; suffix?: string; duration?: number }) {
  const [count, setCount] = useState(0);
  const { ref, visible } = useInView(0.3);
  useEffect(() => {
    if (!visible) return;
    let start = 0;
    const step = Math.ceil(end / (duration / 16));
    const id = setInterval(() => {
      start += step;
      if (start >= end) { setCount(end); clearInterval(id); }
      else setCount(start);
    }, 16);
    return () => clearInterval(id);
  }, [visible, end, duration]);
  return <span ref={ref}>{count}{suffix}</span>;
}

// ─── Section wrapper with fade-in ────────────────────────────────────────────
function Section({ children, className = "", id }: { children: React.ReactNode; className?: string; id?: string }) {
  const { ref, visible } = useInView();
  return (
    <section
      ref={ref}
      id={id}
      className={`landing-section ${visible ? "landing-visible" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

/* ═════════════════════════════════════════════════════════════════════════════ */

export default function LandingPage() {
  const [mobileNav, setMobileNav] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="landing-root">
      {/* ═══════════ NAVBAR ═══════════ */}
      <nav className={`landing-nav ${scrolled ? "landing-nav-scrolled" : ""}`}>
        <div className="landing-nav-inner">
          {/* Logo */}
          <a href="/" className="landing-logo">
            <img src="https://localmote.com/web/uploads/catalogs/81f6e364-0779-4b50-a38c-9018e551ac1b/logo/logo.png" alt="InFynd" className="landing-logo-icon" />
            <span className="landing-logo-text">
              InFynd <span className="landing-logo-badge">V1</span>
            </span>
          </a>

          {/* Desktop links */}
          <div className="landing-nav-links">
            <a href="#how-it-works">How It Works</a>
            <a href="#features">Features</a>
            <a href="#channels">Channels</a>
            <a href="#security">Security</a>
          </div>

          {/* CTA */}
          <div className="landing-nav-actions">
            <a href="/dashboard" className="landing-nav-login">Log in</a>
            <a href="/dashboard" className="landing-btn-primary landing-btn-sm">
              Start Free
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </a>
          </div>

          {/* Mobile hamburger */}
          <button className="landing-hamburger" onClick={() => setMobileNav(!mobileNav)} aria-label="Menu">
            <span /><span /><span />
          </button>
        </div>

        {/* Mobile slide-out */}
        {mobileNav && (
          <div className="landing-mobile-nav">
            <a href="#how-it-works" onClick={() => setMobileNav(false)}>How It Works</a>
            <a href="#features" onClick={() => setMobileNav(false)}>Features</a>
            <a href="#channels" onClick={() => setMobileNav(false)}>Channels</a>
            <a href="#security" onClick={() => setMobileNav(false)}>Security</a>
            <a href="/dashboard" className="landing-btn-primary landing-btn-sm" style={{ marginTop: 8 }}>Start Free →</a>
          </div>
        )}
      </nav>

      {/* ═══════════ HERO ═══════════ */}
      <header className="landing-hero">
        <div className="landing-hero-bg" />
        <div className="landing-hero-content">
          <div className="landing-hero-badge">
            <span className="landing-pulse-dot" />
            AI-Powered Multi-Agent Engine
          </div>
          <h1 className="landing-hero-title font-display">
            Your Outreach.<br />
            <span className="text-gradient-brand">Fully Autonomous.</span>
          </h1>
          <p className="landing-hero-sub">
            InFynd deploys 5 specialized AI agents that classify your audience, find ideal contacts,
            pick the right channel, and generate hyper-personalized messages — across Email,
            LinkedIn &amp; Voice — in seconds, not hours.
          </p>
          <div className="landing-hero-ctas">
            <a href="/dashboard" className="landing-btn-primary landing-btn-lg">
              Launch Your First Campaign
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </a>
            <a href="#how-it-works" className="landing-btn-ghost landing-btn-lg">
              See How It Works
            </a>
          </div>
          <div className="landing-hero-stats">
            <div className="landing-stat">
              <span className="landing-stat-num"><Counter end={5} /> Agents</span>
              <span className="landing-stat-label">Working in parallel</span>
            </div>
            <div className="landing-stat-divider" />
            <div className="landing-stat">
              <span className="landing-stat-num"><Counter end={3} /> Channels</span>
              <span className="landing-stat-label">Email · LinkedIn · Voice</span>
            </div>
            <div className="landing-stat-divider" />
            <div className="landing-stat">
              <span className="landing-stat-num"><Counter end={10} suffix="x" /></span>
              <span className="landing-stat-label">Faster than manual</span>
            </div>
          </div>
        </div>
        {/* Decorative floating cards */}
        <div className="landing-hero-visual">
          <div className="landing-float-card landing-float-1">
            <div className="landing-fc-icon">📧</div>
            <div className="landing-fc-text">
              <strong>Email Generated</strong>
              <span>Personalized cold email with CTA</span>
            </div>
          </div>
          <div className="landing-float-card landing-float-2">
            <div className="landing-fc-icon">💼</div>
            <div className="landing-fc-text">
              <strong>LinkedIn Message</strong>
              <span>Networking-optimized outreach</span>
            </div>
          </div>
          <div className="landing-float-card landing-float-3">
            <div className="landing-fc-icon">📞</div>
            <div className="landing-fc-text">
              <strong>Call Script + Audio</strong>
              <span>WAV generated from template</span>
            </div>
          </div>
        </div>
      </header>

      {/* ═══════════ TRUSTED BY ═══════════ */}
      <Section className="landing-trust-bar">
        <p className="landing-trust-label">Built for modern sales &amp; marketing teams</p>
        <div className="landing-trust-logos">
          {["SaaS Startups", "Fintech", "Enterprise", "Agencies", "Consultants"].map((t) => (
            <span key={t} className="landing-trust-item">{t}</span>
          ))}
        </div>
      </Section>

      {/* ═══════════ HOW IT WORKS ═══════════ */}
      <Section id="how-it-works" className="landing-how">
        <div className="landing-section-header">
          <span className="landing-section-tag">How It Works</span>
          <h2 className="landing-section-title font-display">
            From Prompt to Pipeline<br />in <span className="text-gradient-brand">4 Steps</span>
          </h2>
          <p className="landing-section-desc">
            Describe your campaign in plain English. Our multi-agent AI takes it from there.
          </p>
        </div>

        <div className="landing-steps">
          {[
            {
              num: "01",
              icon: "🧠",
              title: "Classify & Parse",
              desc: "The Classification Agent analyzes your prompt — extracting intent, audience, geography, business behavior, and urgency in real-time.",
              color: "var(--brand-500)",
            },
            {
              num: "02",
              icon: "🎯",
              title: "Find Your ICP",
              desc: "The ICP Module matches and enriches target audiences from our contact database, scoring high-priority profiles most likely to convert.",
              color: "#8b5cf6",
            },
            {
              num: "03",
              icon: "📡",
              title: "Choose Best Channel",
              desc: "The Platform Decision Agent picks Email, LinkedIn, or Voice for each contact based on urgency, engagement history, and ICP preferences.",
              color: "#06b6d4",
            },
            {
              num: "04",
              icon: "✍️",
              title: "Generate Content",
              desc: "The Content Agent crafts platform-optimized messages with adaptive tone — formal emails, conversational LinkedIn, persuasive call scripts.",
              color: "#10b981",
            },
          ].map((step, i) => (
            <div key={step.num} className="landing-step" style={{ animationDelay: `${i * 0.1}s` }}>
              <div className="landing-step-num" style={{ background: step.color }}>{step.num}</div>
              <div className="landing-step-icon">{step.icon}</div>
              <h3 className="landing-step-title">{step.title}</h3>
              <p className="landing-step-desc">{step.desc}</p>
              {i < 3 && <div className="landing-step-connector" />}
            </div>
          ))}
        </div>
      </Section>

      {/* ═══════════ FEATURES ═══════════ */}
      <Section id="features" className="landing-features">
        <div className="landing-section-header">
          <span className="landing-section-tag">Features</span>
          <h2 className="landing-section-title font-display">
            Everything You Need to<br /><span className="text-gradient-brand">Outreach at Scale</span>
          </h2>
        </div>

        <div className="landing-features-grid">
          {[
            {
              icon: "🤖",
              title: "Multi-Agent AI Pipeline",
              desc: "5 specialized agents work sequentially — parsing, classifying, retrieving contacts, deciding channels, and generating content.",
            },
            {
              icon: "⚡",
              title: "One-Prompt Campaigns",
              desc: "Describe your goal in plain English. AI extracts company, audience, platform, purpose, and tone automatically.",
            },
            {
              icon: "🎭",
              title: "Adaptive Tone Engine",
              desc: "Content auto-adjusts between formal, persuasive, and conversational styles based on channel and audience signals.",
            },
            {
              icon: "👤",
              title: "Deep Personalization",
              desc: "Tokens like [CONTACT_NAME], [CONTACT_COMPANY] are injected at send-time for true 1:1 personalization at scale.",
            },
            {
              icon: "📊",
              title: "Real-Time Analytics",
              desc: "Track opens, clicks, and conversions across all channels with built-in SendGrid webhooks and call tracking.",
            },
            {
              icon: "✅",
              title: "Approval Workflows",
              desc: "Review and edit every template per-channel before sending, or flip auto-approve for full autonomy.",
            },
          ].map((f) => (
            <div key={f.title} className="landing-feature-card">
              <div className="landing-feature-icon">{f.icon}</div>
              <h3 className="landing-feature-title">{f.title}</h3>
              <p className="landing-feature-desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ═══════════ CHANNELS SHOWCASE ═══════════ */}
      <Section id="channels" className="landing-channels">
        <div className="landing-section-header">
          <span className="landing-section-tag">Channels</span>
          <h2 className="landing-section-title font-display">
            Three Channels.<br /><span className="text-gradient-brand">One Brain.</span>
          </h2>
          <p className="landing-section-desc">
            Every contact gets the right message on the right platform — decided by AI, not guesswork.
          </p>
        </div>

        <div className="landing-channels-grid">
          {/* Email */}
          <div className="landing-channel-card landing-channel-email">
            <div className="landing-channel-header">
              <span className="landing-channel-icon">📧</span>
              <h3>Email</h3>
            </div>
            <div className="landing-channel-preview">
              <div className="landing-email-line landing-email-subject">
                <span className="landing-email-label">Subject:</span>
                <span>Quick question about [CONTACT_COMPANY]&apos;s growth</span>
              </div>
              <div className="landing-email-body">
                Hi [CONTACT_NAME],<br /><br />
                I noticed [CONTACT_COMPANY] is scaling fast. We helped similar teams cut outreach time by 10x...<br /><br />
                <span className="landing-email-cta">Book a 15-min Demo →</span>
              </div>
            </div>
            <ul className="landing-channel-features">
              <li>Personalization tokens auto-injected</li>
              <li>Subject line + body + CTA link</li>
              <li>SendGrid delivery &amp; tracking</li>
            </ul>
          </div>

          {/* LinkedIn */}
          <div className="landing-channel-card landing-channel-linkedin">
            <div className="landing-channel-header">
              <span className="landing-channel-icon">💼</span>
              <h3>LinkedIn</h3>
            </div>
            <div className="landing-channel-preview">
              <div className="landing-linkedin-msg">
                Hey [CONTACT_NAME] — saw your work at [CONTACT_COMPANY]. We&apos;re helping teams like yours automate outbound with AI. Worth a quick look? 🚀
              </div>
            </div>
            <ul className="landing-channel-features">
              <li>Under 300 chars for connection limits</li>
              <li>Networking-optimized tone</li>
              <li>Auto CTA link insertion</li>
            </ul>
          </div>

          {/* Call */}
          <div className="landing-channel-card landing-channel-call">
            <div className="landing-channel-header">
              <span className="landing-channel-icon">📞</span>
              <h3>Voice / Call</h3>
            </div>
            <div className="landing-channel-preview">
              <div className="landing-call-script">
                <div className="landing-call-line">
                  <span className="landing-call-tag">Greeting</span>
                  Hi [CONTACT_NAME], this is Alex from InFynd...
                </div>
                <div className="landing-call-line">
                  <span className="landing-call-tag">Value Prop</span>
                  We help teams automate multi-channel outreach...
                </div>
                <div className="landing-call-line">
                  <span className="landing-call-tag">Objection</span>
                  I understand. Many felt the same until...
                </div>
              </div>
            </div>
            <ul className="landing-channel-features">
              <li>Full call script with objection handling</li>
              <li>Built-in WAV audio generation (TTS)</li>
              <li>Twilio voice dispatch integration</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ═══════════ SECURITY & TRUST ═══════════ */}
      <Section id="security" className="landing-security">
        <div className="landing-section-header">
          <span className="landing-section-tag">Security &amp; Trust</span>
          <h2 className="landing-section-title font-display">
            Enterprise-Grade<br /><span className="text-gradient-brand">AI Governance</span>
          </h2>
        </div>

        <div className="landing-security-grid">
          {[
            {
              icon: (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              ),
              title: "Role-Based Access Control",
              desc: "Fine-grained RBAC ensures only authorized team members can create, approve, or dispatch campaigns.",
            },
            {
              icon: (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              ),
              title: "Encrypted Storage",
              desc: "All contact data and generated content encrypted at rest and in transit with industry-standard protocols.",
            },
            {
              icon: (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              ),
              title: "Full Prompt Logging",
              desc: "Every AI agent interaction is logged with timestamps, durations, and status — complete audit trail.",
            },
            {
              icon: (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
              ),
              title: "Approval Workflows",
              desc: "Human-in-the-loop review before any message is sent. Edit, regenerate, or approve per-channel.",
            },
          ].map((item) => (
            <div key={item.title} className="landing-security-card">
              <div className="landing-security-icon">{item.icon}</div>
              <h3 className="landing-security-title">{item.title}</h3>
              <p className="landing-security-desc">{item.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ═══════════ FINAL CTA ═══════════ */}
      <Section className="landing-final-cta">
        <div className="landing-cta-card">
          <div className="landing-cta-bg" />
          <div className="landing-cta-content">
            <h2 className="landing-cta-title font-display">
              Ready to Automate<br />Your Outreach?
            </h2>
            <p className="landing-cta-desc">
              Stop writing messages one by one. Let AI agents handle the heavy lifting while you focus on closing deals.
            </p>
            <div className="landing-cta-actions">
              <a href="/dashboard" className="landing-btn-white landing-btn-lg">
                Get Started Free
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              </a>
            </div>
            <p className="landing-cta-note">No credit card required · Free tier available</p>
          </div>
        </div>
      </Section>

      {/* ═══════════ FOOTER ═══════════ */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div className="landing-footer-brand">
            <a href="/" className="landing-logo">
              <img src="https://localmote.com/web/uploads/catalogs/81f6e364-0779-4b50-a38c-9018e551ac1b/logo/logo.png" alt="InFynd" className="landing-logo-icon" />
              <span className="landing-logo-text">InFynd</span>
            </a>
            <p className="landing-footer-tagline">
              Multi-Agent Intelligent Content<br />Generation &amp; Decision System
            </p>
          </div>
          <div className="landing-footer-links">
            <div className="landing-footer-col">
              <h4>Product</h4>
              <a href="#features">Features</a>
              <a href="#channels">Channels</a>
              <a href="#how-it-works">How It Works</a>
              <a href="#security">Security</a>
            </div>
            <div className="landing-footer-col">
              <h4>Resources</h4>
              <a href="/dashboard">Dashboard</a>
              <a href="#">Documentation</a>
              <a href="#">API Reference</a>
            </div>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span>© 2026 InFynd. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
