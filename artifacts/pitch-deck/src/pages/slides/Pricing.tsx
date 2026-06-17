export default function Pricing() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-bg font-body">
      <div className="absolute top-[7vh] right-[6vw] text-muted text-[1.1vw] font-medium tracking-widest">
        08 / 09
      </div>

      <div className="h-full flex flex-col justify-center px-[6vw]">
        <p className="text-primary text-[1.3vw] font-semibold tracking-[0.3em] uppercase mb-[2vh]">
          Pricing
        </p>
        <h2 className="text-text font-display font-bold text-[5.2vw] leading-[0.98] tracking-tighter">
          Plans that scale with you
        </h2>

        <div className="grid grid-cols-4 gap-[1.4vw] mt-[5vh] items-stretch">
          <div className="bg-white rounded-[1vw] p-[1.8vw] border border-line flex flex-col">
            <span className="text-text font-display font-medium text-[1.7vw]">Starter</span>
            <div className="flex items-baseline gap-[0.4vw] mt-[1.5vh] mb-[2.5vh]">
              <span className="text-text font-display font-bold text-[3.2vw] leading-none">$49</span>
              <span className="text-muted text-[1.1vw]">/mo</span>
            </div>
            <div className="w-full h-[1px] bg-line mb-[2.5vh]" />
            <p className="text-text text-[1.25vw] leading-relaxed">2 admins · 5 users</p>
            <p className="text-text text-[1.25vw] leading-relaxed">500 contacts</p>
            <p className="text-muted text-[1.25vw] leading-relaxed mt-[1.5vh]">Analytics, AI qualification, email campaigns</p>
          </div>

          <div className="bg-ink rounded-[1vw] p-[1.8vw] flex flex-col relative">
            <span className="absolute top-[-1.4vh] left-[1.8vw] bg-primary text-white text-[0.95vw] font-semibold tracking-wide uppercase px-[1vw] py-[0.5vh] rounded-full">
              Most popular
            </span>
            <span className="text-white font-display font-medium text-[1.7vw]">Professional</span>
            <div className="flex items-baseline gap-[0.4vw] mt-[1.5vh] mb-[2.5vh]">
              <span className="text-primary font-display font-bold text-[3.2vw] leading-none">$149</span>
              <span className="text-white/55 text-[1.1vw]">/mo</span>
            </div>
            <div className="w-full h-[1px] bg-white/15 mb-[2.5vh]" />
            <p className="text-white text-[1.25vw] leading-relaxed">5 admins · 25 users</p>
            <p className="text-white text-[1.25vw] leading-relaxed">5,000 contacts</p>
            <p className="text-white/65 text-[1.25vw] leading-relaxed mt-[1.5vh]">Enrichment, workflows, WhatsApp, proposals</p>
          </div>

          <div className="bg-white rounded-[1vw] p-[1.8vw] border border-line flex flex-col">
            <span className="text-text font-display font-medium text-[1.7vw]">Business</span>
            <div className="flex items-baseline gap-[0.4vw] mt-[1.5vh] mb-[2.5vh]">
              <span className="text-text font-display font-bold text-[3.2vw] leading-none">$399</span>
              <span className="text-muted text-[1.1vw]">/mo</span>
            </div>
            <div className="w-full h-[1px] bg-line mb-[2.5vh]" />
            <p className="text-text text-[1.25vw] leading-relaxed">10 admins · 100 users</p>
            <p className="text-text text-[1.25vw] leading-relaxed">50,000 contacts</p>
            <p className="text-muted text-[1.25vw] leading-relaxed mt-[1.5vh]">CRM sync, API access, custom branding</p>
          </div>

          <div className="bg-white rounded-[1vw] p-[1.8vw] border border-line flex flex-col">
            <span className="text-text font-display font-medium text-[1.7vw]">Enterprise</span>
            <div className="flex items-baseline gap-[0.4vw] mt-[1.5vh] mb-[2.5vh]">
              <span className="text-text font-display font-bold text-[3.2vw] leading-none">Custom</span>
            </div>
            <div className="w-full h-[1px] bg-line mb-[2.5vh]" />
            <p className="text-text text-[1.25vw] leading-relaxed">Unlimited users</p>
            <p className="text-text text-[1.25vw] leading-relaxed">Unlimited contacts</p>
            <p className="text-muted text-[1.25vw] leading-relaxed mt-[1.5vh]">Organizer portal, multi-company, dedicated support</p>
          </div>
        </div>

        <div className="flex items-center gap-[1vw] mt-[5vh]">
          <div className="w-[3vw] h-[1px] bg-primary" />
          <span className="text-muted text-[1.35vw] font-medium">
            Free plan to start · 14-day trial on every paid plan
          </span>
        </div>
      </div>
    </div>
  );
}
