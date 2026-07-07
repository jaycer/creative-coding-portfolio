// if the browser doesn't have the glyph json data
// fetch it
// check if the url refers to a specific glyph
// if so, show info about that one first
// using the full json of glyphs
// show them to the user one by one
// put the current glyph into the browser history
// the user can view each glyph and favorite or skip
// build an arrays of favorite glyphs
// set the value of a div to the favorite array space separated
// notes:
// glyphs that challenge layout 𓃐 𓇀 𓂨

var hvModule = {
    index: 0,
    glyphSet: [],
    likedGlyphs: [],
    isInfoVisible: false,

    like: function () {
        let glyph = this.glyphSet[this.index].Hieroglyph

        this.likedGlyphs.unshift(glyph)
        this.likeddisplay.innerHTML = `${glyph} ${this.likeddisplay.innerHTML}`

        return false
    },
    increment: function () {
        if (this.index < this.glyphSet.length-1){
            this.index++
        } else {
            this.index = 0
        }
        this.updateDisplay()
        return false
    },
    decrement: function () {
        if (this.index > 0){
            this.index--
        } else {
            this.index = this.glyphSet.length-1
        }
        this.updateDisplay()
        return false
    },
    toggleInfo: function () {
        if (this.index > 0){
            this.index--
        } else {
            this.index = this.glyphSet.length-1
        }
        this.updateDisplay()
        return false
    },
    copyLink: function () {
        this.copyText(window.location.href)
        this.showToast('.toastcopyurl')
        return false
    },
    copyText: function (text) {
        // navigator.clipboard needs a secure context (https or localhost); it's
        // undefined over plain http (e.g. a LAN IP), so fall back to execCommand.
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => this.legacyCopy(text))
        } else {
            this.legacyCopy(text)
        }
        return false
    },
    legacyCopy: function (text) {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.contentEditable = 'true'
        ta.style.position = 'fixed'
        ta.style.top = '-9999px'
        document.body.appendChild(ta)
        const range = document.createRange()
        range.selectNodeContents(ta)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(range)
        ta.setSelectionRange(0, text.length)   // iOS needs an explicit selection range
        try { document.execCommand('copy') } catch (e) {}
        document.body.removeChild(ta)
        return false
    },
    showToast: function (selector) {
        [].slice.call(document.querySelectorAll(selector))
            .map(el => new bootstrap.Toast(el, {animation: true, autohide: true, delay: 1400}))
            .forEach(t => t.show())
        return false
    },
    updateDisplay: function () {
        let glyph = this.glyphSet[this.index]
        const nSlasha = "n/a"
        document.title = `${glyph.Hieroglyph} ~ hieroglyph viewer ~ Jayce Renner`

        // Render each glyph as a FRESH element and crossfade to it. A brand-new
        // element has no stale overflow ink, so iOS WebKit can't leave a ghost of a
        // taller previous glyph (the bug was an in-place content swap not repainting
        // the overflow) — and there's no forced repaint to watch draw. The outgoing
        // element fades out (opacity carries its overflow away) and is removed once
        // hidden.
        const prev = this._glyphEl
        const el = document.createElement('span')
        el.className = 'no-touch-zoom glyph'
        el.innerHTML = glyph.Hieroglyph
        this.glyphstage.appendChild(el)
        requestAnimationFrame(() => {
            el.classList.add('shown')
            if (prev) {
                prev.classList.remove('shown')
                setTimeout(() => { if (prev.parentNode) prev.parentNode.removeChild(prev) }, 250)
            }
        })
        this._glyphEl = el
        this.indexdisplay.innerHTML = (this.index+1) + " / " + this.glyphSet.length
        const desc = glyph.Description || `Gardiner code ${glyph.Gardiner}`
        // >=md info population
        this.nameheading.innerHTML = desc
        this.pgardinercode.innerHTML = glyph.Gardiner || nSlasha
        this.pnotes.innerHTML = glyph.Notes || nSlasha
        this.pphonetic.innerHTML = glyph.Phonetic || nSlasha
        this.ptransliteration.innerHTML = glyph.Transliteration || nSlasha

        // modal info population
        this.smodaltitleglyph.innerHTML = glyph.Hieroglyph
        this.mpdescription.innerHTML = glyph.Description || nSlasha
        this.mpgardinercode.innerHTML = glyph.Gardiner || nSlasha
        this.mpnotes.innerHTML = glyph.Notes || nSlasha
        this.mpphonetic.innerHTML = glyph.Phonetic || nSlasha
        this.mptransliteration.innerHTML = glyph.Transliteration || nSlasha

        // put the hieroglyph in the url and into browser history. Use the glyph
        // itself — URLSearchParams percent-encodes it once (e.g. %F0%93%85%B0).
        // Setting the already-encoded UrlEncoded here would re-encode the % signs
        // and produce a double-encoded, ugly share link (%25F0%2593...).
        const url = new URL(window.location)
        url.searchParams.set('h', glyph.Hieroglyph)
        window.history.pushState({}, '', url)

        return false
    },
    copyLikes: function() {
        this.copyText(this.likeddisplay.textContent.trim())
        this.showToast('.toastcopyglyphs')
        return false
    },
    keyPressHandler: function (e) {
        //e.preventDefault()
        //console.log(e.key)

        if (e.key == "ArrowRight" || e.key == "Enter") {
            hvModule.increment()
        }
        if (e.key == "ArrowLeft") {
            hvModule.decrement()
        }
        if (e.key == "ArrowUp") {
            hvModule.like()
        }
        if (e.key == "ArrowDown") {
            hvModule.copyLikes()
        }
        return false
    },
    fetchGlyphData: function() {
        // put this in the browser cache and save a request?
        fetch("./media/hieroglyphs.min.json")
            .then((res) => {
                return res.json()
            })
            .then((data) => {
                this.glyphSet = data.data
            })
            .finally(() => {
                this.completeSetup()
            } );
    },
    completeSetup: function() {
        // randomly sort the array per the Fisher Yates Method
        for (let i = this.glyphSet.length - 1; i > 0; i--) {
            let j = Math.floor(Math.random() * (i + 1))
            let k = this.glyphSet[i]
            this.glyphSet[i] = this.glyphSet[j]
            this.glyphSet[j] = k
        }
        
        let els = ['smodaltitleglyph','mpdescription','mpgardinercode','mpnotes','mpphonetic','mptransliteration','pphonetic','ptransliteration','glyphstage','nameheading','indexdisplay','likeddisplay','pgardinercode','pnotes']
        this.populateProperties(els)

        document.addEventListener("keydown", this.keyPressHandler)

        // Flash the nav buttons when tapped/clicked so interactions are visible
        // (e.g. in a screen recording). Re-trigger the animation on each tap.
        document.querySelectorAll('.nav-btn').forEach((btn) => {
            btn.addEventListener('click', function () {
                this.classList.remove('flash')
                void this.offsetWidth   // reflow so a rapid re-tap restarts the animation
                this.classList.add('flash')
            })
        })

        let params = (new URL(document.location)).searchParams
        let h = params.get('h')

        if (h) {
            // find the index for the hieroglyph param
            let index = 0

            if (h.startsWith('%')) {
                // probably the glyph is url encoded
                this.index = this.glyphSet.findIndex((x) => x.UrlEncoded == h)
            } else {
                // try looking it up by the glyph itself
                this.index = this.glyphSet.findIndex((x) => x.Hieroglyph == h)
            }

            // if we couldn't find a glyph, just go to the first one
            if (this.index < 0) this.index = 0
        }
        this.updateDisplay()

        return false
    },

    populateProperties: function(listOfElementIds) {
        // takes an array of element ids
        // gets them from the dom
        // populates object properties
        for(let el of listOfElementIds){
            this[el] = document.getElementById(el)
        }
        return false
    },

    hvInit: function () {
        this.index = 0
        this.fetchGlyphData()

        return false
    },

};

hvModule.hvInit();

/*
possibly not g-rated
𓀏	man with arms tied behind his back
𓀐	falling man with blood streaming from his head
𓀑	man whose head is hit with an axe
𓀜	man striking with both hands
𓀝	man striking, with left arm hanging behind back
𓁄	man threatening with stick
𓁊	man wearing tunic with fringes and holding mace
𓁍	man holding up knife
𓁒	woman giving birth
𓁓	combination of woman giving birth and three skins tied together
𓁔	woman suckling child
𓁕	woman suckling child (simplified)
𓁤	ithyphallic god with two plumes, uplifted arm and flagellum
𓂑	small breast
𓂒	large breast
𓂸	phallus
𓂹	phallus with folded cloth
𓂺	phallus with emission
𓄖	hind-quarters of lion
𓄗	foreleg of ox
𓄘	foreleg of ox reversed
𓄚	skin of goat
𓄡	animal's belly
𓄰	uterus
𓄱	uterus
*/