;; Long-lived Chez guest for the C-ABI transport.
;; `dsh-dispatch` receives one ASCII request datum and returns one UTF-8 JSON bytevector.
;; State is deliberately kept across calls; no stdin/stdout or REPL prompt is involved.
(import (chezscheme))
(load "/plugin-loader.scm")

(define state 0)
(define memfs-stage "start")
(define (mark-stage name value) (set! memfs-stage name) value)

(define hex-digits "0123456789abcdef")

(define (write-unicode-escape c out)
  (let ((n (char->integer c)))
    (display "\\u00" out)
    (write-char (string-ref hex-digits (quotient n 16)) out)
    (write-char (string-ref hex-digits (remainder n 16)) out)))

(define (json-escape s)
  (let ((out (open-output-string)))
    (for-each
      (lambda (c)
        (cond
          ((char=? c #\") (display "\\\"" out))
          ((char=? c #\\) (display "\\\\" out))
          ((char=? c #\newline) (display "\\n" out))
          ((char=? c #\return) (display "\\r" out))
          ((char=? c #\tab) (display "\\t" out))
          ((< (char->integer c) 32) (write-unicode-escape c out))
          (else (write-char c out))))
      (string->list s))
    (get-output-string out)))

(define (respond id ok value)
  (let ((text (if (string? value) value (format "~a" value))))
    (string-append
      "{\"id\":\"" (json-escape (if (string? id) id (format "~a" id)))
      "\",\"ok\":" (if ok "true" "false")
      ",\"value\":" text "}")))

(define (json-bool x) (if x "true" "false"))

(define (json-join items)
  (if (null? items)
      ""
      (string-append
        (json-value (car items))
        (if (null? (cdr items)) "" (string-append "," (json-join (cdr items)))))))

(define (json-value v)
  (cond
    ((number? v)
     (if (and (real? v) (finite? v))
         (number->string (if (integer? v) v (exact->inexact v)))
         (error 'json-value "non-finite or non-real number")))
    ((string? v) (string-append "\"" (json-escape v) "\""))
    ((boolean? v) (json-bool v))
    ((null? v) "[]")
    ((list? v) (string-append "[" (json-join v) "]"))
    (else (error 'json-value "unsupported JSON value"))))

(define (respond-error id code)
  (string-append
    "{\"id\":\"" (json-escape id) "\",\"ok\":false,\"error\":{\"code\":\""
    (json-escape code) "\"}}"))

(define (respond-suspended id rid kind rule target args)
  (string-append
    "{\"id\":\"" (json-escape id) "\",\"ok\":true,\"status\":\"suspended\""
    ",\"requestId\":\"" (json-escape rid) "\""
    ",\"kind\":\"" (json-escape kind) "\""
    ",\"ruleHash\":\"" (json-escape rule) "\""
    ",\"target\":\"" (json-escape target) "\""
    ",\"args\":" (json-value args) "}"))

;; Blocking host bridge: the frame body is strict JSON. JSON escaping removes
;; tab/newline injection and the host rejects any field outside its schema.
(define MAX-FFI-FRAME 65536) ; UTF-8 bytes, not characters

(define current-ffi-rule "")
(define current-ffi-token "")
(define ffi-rid 0)

(define (next-ffi-rid)
  (set! ffi-rid (+ ffi-rid 1))
  (string-append "ffi-" (number->string ffi-rid)))

(define (host-ffi-exchange rid kind rule target args token)
  (let ((frame (string-append
      "{\"id\":\"ffi\""
      ",\"rid\":\"" (json-escape rid) "\""
      ",\"kind\":\"" (json-escape kind) "\""
      ",\"rule\":\"" (json-escape rule) "\""
      ",\"target\":\"" (json-escape target) "\""
      ",\"token\":\"" (json-escape token) "\""
      ",\"args\":" (json-value args) "}")))
    (if (> (bytevector-length (string->utf8 frame)) MAX-FFI-FRAME)
        (plugin-error 'E-FFI-FRAME-TOO-LARGE)
        (begin
          (display "DSH-FFI\t")
          (display frame)
          (newline)
          (flush-output-port)
          (let ((line (get-line (current-input-port))))
            (if (eof-object? line)
                (plugin-error 'E-HOST-EOF)
                (let ((reply (read (open-input-string line))))
                  (if (and (pair? reply) (memq (car reply) '(ok error)))
                      reply
                      (plugin-error 'E-HOST)))))))))

(define (host-ffi-call id rid kind rule target args . token)
  (let ((reply (host-ffi-exchange rid kind rule target args
                  (if (null? token) current-ffi-token (car token)))))
    (if (eq? (car reply) 'ok)
        (respond id #t (json-value (cadr reply)))
        (respond-error id (cadr reply)))))

(define (host-ffi-value target args)
  (let ((reply (host-ffi-exchange (next-ffi-rid) "ffi" current-ffi-rule target args current-ffi-token)))
    (if (eq? (car reply) 'ok)
        (cadr reply)
        (plugin-error (cadr reply)))))

(define FFI-LIBRARY-SOURCE
  "(library (dsh ffi (6))
     (export ffi-call)
     (import (chezscheme))
     (define (ffi-call target . args)
       ((eval 'host-ffi-value (interaction-environment)) target args)))")

(eval (read (open-input-string FFI-LIBRARY-SOURCE)) (interaction-environment))

(define pending #f)

(define (read-text path)
  (unless (file-exists? path) (raise 'missing-file))
  (call-with-input-file path (lambda (p) (get-string-all p))))

(define (describe-error e)
  (guard (x (else "unprintable-error"))
    (if (condition? e)
        (let ((msg (condition-message e))
              (irritants (condition-irritants e)))
          (if (null? irritants) msg (apply format msg irritants)))
        (format "~a" e))))

(define (attempt thunk)
  (call/cc
    (lambda (escape)
      (with-exception-handler
        (lambda (e) (escape (cons #f (describe-error e))))
        (lambda () (cons #t (thunk)))))))

(define (denied? thunk)
  (not (car (attempt thunk))))

(define (plugin-value id)
  (let ((source (read-text "/project/lib/plugin.scm")))
    (load-plugin-source! source)
    (respond id #t (number->string (plugin-call 'demo 'answer)))))

(define (memfs-test id)
  (let ((result
         (attempt
          (lambda ()
            (let* ((source (mark-stage "source" (read-text "/project/lib/mem.scm")))
                   (project-write-denied
                    (mark-stage "project-write"
                      (denied? (lambda ()
                                 (call-with-output-file "/project/evil.txt"
                                   (lambda (p) (display "x" p)))))))
                   (out-write (mark-stage "out-write"
                     (attempt
                      (lambda ()
                        (call-with-output-file "/out/result.txt"
                          (lambda (p) (display "ok" p)))))))
                   (out-read (mark-stage "out-read" (attempt (lambda () (read-text "/out/result.txt")))))
                   (loaded (mark-stage "load" (attempt (lambda () (load-plugin-source! source)))))
                   (answer-result
                    (mark-stage "answer"
                      (if (car loaded)
                          (attempt (lambda () (plugin-call 'mem 'answer)))
                          (cons #f "not-loaded"))))
                   (answer (if (car answer-result) (cdr answer-result) -1)))
              (begin
                (mark-stage "serialize" #t)
                (format
                 "{\"projectValue\":~a,\"projectWriteDenied\":~a,\"outWrite\":~a,\"outRead\":~a,\"loadOk\":~a,\"outError\":\"~a\"}"
                 (mark-stage "ser-pv" (if (number? answer) (number->string answer) "-1"))
                 (mark-stage "ser-project-write" (json-bool project-write-denied))
                 (mark-stage "ser-out-write" (json-bool (and (pair? out-write) (car out-write))))
                 (mark-stage "ser-out-read" (json-bool (and (pair? out-read) (car out-read) (string? (cdr out-read)) (string=? (cdr out-read) "ok"))))
                 (mark-stage "ser-load" (json-bool (and (pair? loaded) (car loaded))))
                 (mark-stage "ser-out-error" (if (and (pair? out-write) (not (car out-write))) (cdr out-write) "")))))))))
    (if (car result)
        (begin (mark-stage "respond" #t) (respond id #t (cdr result)))
        (respond id #t (string-append
                         "{\"error\":\"memfs-failed\",\"stage\":\"" (json-escape memfs-stage)
                         "\",\"detail\":\"" (json-escape (cdr result)) "\"}")))))

(define (memfs-quota id)
  (let ((quota-denied
         (denied? (lambda ()
                    (call-with-output-file "/out/big.txt"
                      (lambda (p) (display (make-string 70000 #\x) p)))))))
    (respond id #t
      (string-append "{\"quotaDenied\":" (json-bool quota-denied) "}"))))

;; ---------------------------------------------------------------------------
;; Experimental pin v2 verification (Phase 5)
;; ---------------------------------------------------------------------------

(define (canonical-datum-bytes datum)
  (let-values (((out extract) (open-bytevector-output-port)))
    (emit-datum out datum)
    (extract)))

(define (domain-hash domain datum)
  (bytevector->hex
    (sha256
      (concat-bv
        (string->utf8 (string-append domain (string (integer->char 0))))
        (canonical-datum-bytes datum)))))

(define (library-version-string name)
  (let ((last (car (reverse name))))
    (if (symbol? last) (symbol->string last) "")))

(define (supported-project-module-name? name)
  (and (list? name)
       (= (length name) 4)
       (eq? (car name) 'dsh)
       (memq (cadr name) '(lib plugin))
       (symbol? (caddr name))
       (symbol? (cadddr name))))

(define (pin-import-base-spec spec)
  (if (import-wrapper? spec) (pin-import-base-spec (cadr spec)) spec))

(define (pin-project-import-names imports)
  (define (insert value rest)
    (cond ((null? rest) (list value))
          ((string<? value (car rest)) (cons value rest))
          (else (cons (car rest) (insert value (cdr rest))))))
  (let loop ((specs imports) (out '()))
    (if (null? specs)
        out
        (let* ((name (pin-import-base-spec (car specs)))
               (project? (and (pair? name) (eq? (car name) 'dsh)
                              (not (equal? name '(dsh safe eval (6))))
                              (not (equal? name '(dsh ffi (6)))))))
          (if project?
              (let ((text (name-string name)))
                (if (member text out)
                    (loop (cdr specs) out)
                    (loop (cdr specs) (insert text out))))
              (loop (cdr specs) out))))))

(define (module-record desc)
  (list 'module
        (name-string (desc-name desc))
        (library-version-string (desc-name desc))
        (desc-tree desc)
        (pin-project-import-names (desc-imports desc))))

(define (sorted-module-records modules)
  (define (insert record rest)
    (cond ((null? rest) (list record))
          ((string<? (cadr record) (cadr (car rest)))
           (cons record rest))
          (else (cons (car rest) (insert record (cdr rest))))))
  (let loop ((xs modules) (out '()))
    (if (null? xs)
        out
        (loop (cdr xs) (insert (module-record (car xs)) out)))))

(define (pin-bundle-hash modules)
  (domain-hash "dsh/source-bundle/v2"
    (cons 'bundle (sorted-module-records modules))))

(define (parse-pin-module module)
  (if (not (and (list? module) (= (length module) 3)
                (string? (list-ref module 0))
                (string? (list-ref module 1))
                (string? (list-ref module 2))))
      (plugin-error 'E-PIN-MODULE-DESCRIPTOR)
      (let* ((expected-name (list-ref module 0))
             (expected-version (list-ref module 1))
             (desc (parse-library (list-ref module 2))))
        (unless (supported-project-module-name? (desc-name desc))
          (plugin-error 'E-PIN-MODULE-KIND (name-string (desc-name desc))))
        (unless (string=? expected-name (name-string (desc-name desc)))
          (plugin-error 'E-PIN-MODULE-NAME expected-name))
        (unless (string=? expected-version (library-version-string (desc-name desc)))
          (plugin-error 'E-PIN-MODULE-VERSION expected-name))
        desc)))

(define (pin-rule-hash rule-id version tree bundle signature plugin-env ffi-env)
  (domain-hash "dsh/rule/v2"
    (list 'rule rule-id version tree bundle signature plugin-env ffi-env)))

(define (pin-values rule-id version source modules plugins ffi signature)
  (let* ((tree (tree-hash source))
         (bundle (pin-bundle-hash modules))
         (plugin-env (domain-hash "dsh/plugin-environment/v2"
                       (cons 'plugin-environment plugins)))
         (ffi-env (domain-hash "dsh/ffi-environment/v2"
                     (cons 'ffi-environment ffi)))
         (rule (pin-rule-hash rule-id version tree bundle signature plugin-env ffi-env)))
    (list tree bundle plugin-env ffi-env rule)))

(define (plugin-load id sources)
  (if (not (and (list? sources) (pair? sources)
                (not (memq #f (map string? sources)))))
      (respond-error id "E-PLUGIN-SOURCES")
      (let ((bundle (load-bundle! sources)))
        (respond id #t (string-append "\"" bundle "\"")))))

(define (plugin-registry-count id)
  (ensure-live-vm!)
  (respond id #t (number->string (plugin-count))))

(define (plugin-pin-bundle id)
  (ensure-live-vm!)
  (respond id #t (string-append "\"" (pin-bundle-hash (loaded-bundle-descs)) "\"")))

(define (plugin-present id name)
  (ensure-live-vm!)
  (if (not (library-name? name))
      (respond-error id "E-PLUGIN-NAME")
      (let ((result (try (lambda () (environment name)))))
        (respond id #t (json-bool (eq? (car result) 'value))))))

(define (pin-verify id desc)
  (if (not (and (pair? desc) (eq? (car desc) 'rule) (>= (length desc) 8)))
      (respond-error id "E-PIN-DESCRIPTOR")
      (let* ((rule-id (list-ref desc 1))
             (version (list-ref desc 2))
             (source (list-ref desc 3))
             (modules (list-ref desc 4))
             (plugins (list-ref desc 5))
             (ffi (list-ref desc 6))
             (signature (list-ref desc 7))
             (parsed-modules (map parse-pin-module modules))
             (values (pin-values rule-id version source parsed-modules plugins ffi signature)))
        (respond id #t
          (string-append
            "{\"treeHash\":\"" (list-ref values 0) "\""
            ",\"bundleHash\":\"" (list-ref values 1) "\""
            ",\"pluginEnvironmentHash\":\"" (list-ref values 2) "\""
            ",\"ffiEnvironmentHash\":\"" (list-ref values 3) "\""
            ",\"ruleHash\":\"" (list-ref values 4) "\"}")))))

;; Atomic metadata publication for pin v2. This parses every project library
;; and rule, validates the import graph, and only then replaces `pin-registry`.
;; Rule bodies are not evaluated: this proves identity/dependency publication,
;; not production execution.
(define pin-registry '())
(define pin-loaded? #f)
(define pin-evaluated? #f)
(define pin-eval-failed? #f)
(define pin-module-forms '())
(define pin-rule-forms '())

(define (pin-find-rule rule-id)
  (let loop ((entries pin-rule-forms))
    (cond ((null? entries) #f)
          ((string=? (car (car entries)) rule-id) (car entries))
          (else (loop (cdr entries))))))

(define (pin-eval-project!)
  (unless pin-evaluated?
    (when pin-eval-failed? (plugin-error 'E-PIN-EVAL-FAILED))
    (dynamic-wind
      void
      (lambda ()
        (for-each
          (lambda (form)
            (eval form (interaction-environment)))
          pin-module-forms)
        (for-each
          (lambda (entry)
            (eval (cadr entry) (interaction-environment)))
          pin-rule-forms)
        (set! pin-evaluated? #t))
      (lambda ()
        (unless pin-evaluated? (set! pin-eval-failed? #t))))))

(define (pin-call id desc)
  (if (not (and (pair? desc) (eq? (car desc) 'call) (>= (length desc) 4)))
      (respond-error id "E-PIN-CALL-DESCRIPTOR")
      (let* ((rule-id (list-ref desc 1))
             (procedure (list-ref desc 2))
             (args (list-ref desc 3)))
        (if (not (and pin-loaded? (string? rule-id) (string? procedure) (list? args)))
            (respond-error id "E-PIN-NOT-LOADED")
            (let ((entry (pin-find-rule rule-id)))
              (if (not entry)
                  (respond-error id "E-PIN-RULE-NOT-LOADED")
                  (let ((result
                          (attempt
                            (lambda ()
                              (pin-eval-project!)
                              (let ((previous current-ffi-rule))
                                (set! current-ffi-rule (list-ref entry 3))
                                (dynamic-wind
                                  void
                                  (lambda ()
                                    (eval (cons (string->symbol procedure) args)
                                          (environment (caddr entry))))
                                  (lambda () (set! current-ffi-rule previous))))))))
                    (if (car result)
                        (respond id #t (json-value (cdr result)))
                        (respond-error id "E-RULE-ERROR")))))))))

(define (pin-load id desc)
  (if (not (and (pair? desc) (eq? (car desc) 'pin) (>= (length desc) 5)))
      (respond-error id "E-PIN-LOAD-DESCRIPTOR")
      (let* ((plugins (list-ref desc 1))
             (ffi (list-ref desc 2))
             (modules (list-ref desc 3))
             (rules (list-ref desc 4))
             (token (if (>= (length desc) 6) (list-ref desc 5) ""))
             (module-descs (map parse-pin-module modules))
             (rule-descs (map (lambda (r) (parse-library (list-ref r 3))) rules))
             (all-descs (append module-descs rule-descs))
             (names (map desc-name all-descs))
             (module-names (map desc-name module-descs)))
        ;; Duplicate declared library names are rejected before publication.
        (let loop ((ns names))
          (unless (null? ns)
            (when (member (car ns) (cdr ns))
              (plugin-error 'E-DUPLICATE-LIBRARY (car ns)))
            (loop (cdr ns))))
        ;; Rule ids are dispatch keys: duplicate ids would silently shadow.
        (let loop ((ids (map (lambda (r) (list-ref r 1)) rules)))
          (unless (null? ids)
            (when (member (car ids) (cdr ids))
              (plugin-error 'E-DUPLICATE-RULE (car ids)))
            (loop (cdr ids))))
        ;; Import edges may close over declared project libraries only. Rules are
        ;; not libraries that modules or rules may import.
        (for-each (lambda (d) (validate-imports! (desc-imports d) module-names)) all-descs)
        ;; Recompute every hash from the exact source that will be published.
        (for-each
          (lambda (r)
            (let* ((rule-id (list-ref r 1))
                   (version (list-ref r 2))
                   (source (list-ref r 3))
                   (signature (list-ref r 4))
                   (tree (list-ref r 5))
                   (bundle (list-ref r 6))
                   (plugin-env (list-ref r 7))
                   (ffi-env (list-ref r 8))
                   (rule (list-ref r 9))
                   (values (pin-values rule-id version source
                             module-descs plugins ffi signature)))
              (unless (string=? tree (list-ref values 0))
                (plugin-error 'E-PIN-MISMATCH-TREE rule-id))
              (unless (string=? bundle (list-ref values 1))
                (plugin-error 'E-PIN-MISMATCH-BUNDLE rule-id))
              (unless (string=? plugin-env (list-ref values 2))
                (plugin-error 'E-PIN-MISMATCH-PLUGIN rule-id))
              (unless (string=? ffi-env (list-ref values 3))
                (plugin-error 'E-PIN-MISMATCH-FFI rule-id))
              (unless (string=? rule (list-ref values 4))
                (plugin-error 'E-PIN-MISMATCH-RULE rule-id))))
          rules)
        ;; Publish only after all checks: a later failure leaves the old registry.
        (set! pin-registry
          (map (lambda (r d)
                 (list (list-ref r 1) (list-ref r 2) (desc-name d)
                       (desc-tree d) (list-ref r 6) (list-ref r 9)))
               rules rule-descs))
        (set! pin-module-forms (map desc-form module-descs))
        (set! pin-rule-forms
          (map (lambda (r d)
                 (list (list-ref r 1) (desc-form d) (desc-name d) (list-ref r 9)))
               rules rule-descs))
        (set! pin-evaluated? #f)
        (set! pin-eval-failed? #f)
        (set! pin-loaded? #t)
        (set! current-ffi-token token)
        (respond id #t
          (string-append "{\"loaded\":true,\"rules\":" (number->string (length rules))
                         ",\"modules\":" (number->string (length modules))
                         ",\"registry\":" (number->string (length pin-registry)) "}")))))

(define (handle req)
  (if (not (and (pair? req) (eq? (car req) 'request) (>= (length req) 3)))
      (respond "?" #f "\"bad request\"")
      (let* ((id (cadr req))
             (op (caddr req))
             (arg (if (>= (length req) 4) (cadddr req) #f)))
        (case op
          ((set)
           (if (number? arg)
               (begin (set! state arg) (respond id #t (number->string state)))
               (respond id #f "\"set requires a number\"")))
          ((get) (respond id #t (number->string state)))
          ((inc)
           (let ((delta (if (number? arg) arg 1)))
             (set! state (+ state delta))
             (respond id #t (number->string state))))
          ((hang)
           (let loop () (loop)))
          ((exit)
           (exit (if (number? arg) arg 0)))
          ((oom)
           (make-vector 100000000 0)
           (respond id #t "0"))
          ((big-output)
           (respond id #t (make-string 1000001 #\x)))
          ((memfs-test) (memfs-test id))
          ((memfs-quota) (memfs-quota id))
          ((plugin-value) (plugin-value id))
          ((plugin-load) (plugin-load id arg))
          ((plugin-registry-count) (plugin-registry-count id))
          ((plugin-pin-bundle) (plugin-pin-bundle id))
          ((plugin-present) (plugin-present id arg))
          ((pin-verify) (pin-verify id arg))
          ((pin-load) (pin-load id arg))
          ((pin-call) (pin-call id arg))
          ((ffi-call)
           (let* ((rid (list-ref req 3))
                  (kind (list-ref req 4))
                  (rule (list-ref req 5))
                  (target (list-ref req 6))
                  (args (if (>= (length req) 8) (list-ref req 7) '()))
                  (token (if (>= (length req) 9) (list-ref req 8) current-ffi-token)))
             (host-ffi-call id rid kind rule target args token)))
          (else (respond id #f "\"unknown op\""))))))

(define (parse-request payload)
  (read (open-input-string payload)))

(define (dsh-dispatch payload)
  (string->utf8
    (call/cc
      (lambda (escape)
        (with-exception-handler
          (lambda (e)
            (escape
              (if (plugin-error? e)
                  (respond-error "?" (symbol->string (plugin-error-code e)))
                  (respond "?" #f (string-append "\"" (json-escape (format "~a" e)) "\"")))))
          (lambda ()
            (escape (handle (parse-request payload)))))))))

(define (handle-resume req)
  (if (not (and (pair? req) (eq? (car req) 'resume) (>= (length req) 3)))
      (respond-error "?" "E-BAD-RESUME")
      (let ((rid (cadr req))
            (ok (caddr req))
            (value (if (>= (length req) 4) (cadddr req) #f)))
        (if (not pending)
            (respond-error "?" "E-NO-PENDING")
            (let ((id (vector-ref pending 0))
                  (expected (vector-ref pending 1)))
              (if (not (string=? rid expected))
                  (respond-error id "E-LATE-RESPONSE")
                  (begin
                    (set! pending #f)
                    (if ok
                        (respond id #t (json-value value))
                        (respond-error id (if (string? value) value "E-HOST"))))))))))

(define (dsh-resume payload)
  (string->utf8
    (call/cc
      (lambda (escape)
        (with-exception-handler
          (lambda (e) (escape (respond-error "?" "E-RESUME")))
          (lambda () (escape (handle-resume (parse-request payload)))))))))
