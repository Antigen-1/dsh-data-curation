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

(define (all-pairs? value)
  (and (pair? value)
       (let loop ((items value))
         (or (null? items)
             (and (pair? items)
                  (pair? (car items))
                  (or (symbol? (car (car items))) (string? (car (car items))))
                  (loop (cdr items)))))))

(define (json-join items)
  (if (null? items)
      ""
      (string-append
        (json-value (car items))
        (if (null? (cdr items)) "" (string-append "," (json-join (cdr items)))))))

(define (json-object-join items)
  (if (null? items)
      ""
      (string-append
        "\"" (json-escape (if (symbol? (car (car items)))
                              (symbol->string (car (car items)))
                              (car (car items)))) "\":"
        (json-value (cdr (car items)))
        (if (null? (cdr items)) "" (string-append "," (json-object-join (cdr items)))))))

(define (json-value v)
  (cond
    ((number? v)
     (if (and (real? v) (finite? v))
         (number->string (if (integer? v) v (exact->inexact v)))
         (error 'json-value "non-finite or non-real number")))
    ((string? v) (string-append "\"" (json-escape v) "\""))
    ((boolean? v) (json-bool v))
    ((vector? v) (string-append "[" (json-join (vector->list v)) "]"))
    ((eq? v 'dsh-null) "null")
    ((eq? v 'dsh-empty-object) "{}")
    ((null? v) "[]")
    ((all-pairs? v) (string-append "{" (json-object-join v) "}"))
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

;; Blocking host bridge over a VM-level byte channel. Frames are a 4-byte
;; big-endian payload length followed by a TLV payload. Neither side parses
;; JSON or a whole-frame string.
(define MAX-FFI-FRAME 65536)

(define current-ffi-rule "")
(define current-ffi-token "")
(define ffi-rid 0)

(define (next-ffi-rid)
  (set! ffi-rid (+ ffi-rid 1))
  (string-append "ffi-" (number->string ffi-rid)))

(define dsh-channel-suffix "__DSH_CHANNEL_SUFFIX__")
(define dsh-channel-in #f)
(define dsh-channel-out #f)

(define (ensure-channel!)
  (unless dsh-channel-in
    (set! dsh-channel-in
      (open-file-input-port
        (string-append "/dev/dsh-in-" dsh-channel-suffix)
        (file-options no-fail)
        (buffer-mode none)))
    (set! dsh-channel-out
      (open-file-output-port
        (string-append "/dev/dsh-out-" dsh-channel-suffix)
        (file-options no-fail)
        (buffer-mode none)))))

(define (make-tlv-buffer) (cons (make-bytevector 256 0) 0))

(define (tlv-buffer-put! buffer byte)
  (let* ((bytes (car buffer)) (length (cdr buffer)))
    (when (= length (bytevector-length bytes))
      (let ((next (make-bytevector (* 2 length) 0)))
        (bytevector-copy! bytes 0 next 0 length)
        (set-car! buffer next)))
    (bytevector-u8-set! (car buffer) length byte)
    (set-cdr! buffer (+ length 1))))

(define (tlv-buffer-bytes buffer)
  (let* ((length (cdr buffer)) (bytes (make-bytevector length 0)))
    (let loop ((index 0))
      (when (< index length)
        (bytevector-u8-set! bytes index (bytevector-u8-ref (car buffer) index))
        (loop (+ index 1))))
    bytes))

(define (tlv-put-u32 buffer n)
  (tlv-buffer-put! buffer (bitwise-and (ash n -24) 255))
  (tlv-buffer-put! buffer (bitwise-and (ash n -16) 255))
  (tlv-buffer-put! buffer (bitwise-and (ash n -8) 255))
  (tlv-buffer-put! buffer (bitwise-and n 255)))

(define (tlv-put-i64 buffer n)
  (when (or (< n -9007199254740991) (> n 9007199254740991))
    (plugin-error 'E-TLV-RANGE))
  (let loop ((shift 56) (value (if (< n 0) (+ n 18446744073709551616) n)))
    (when (>= shift 0)
      (tlv-buffer-put! buffer (bitwise-and (ash value (- shift)) 255))
      (loop (- shift 8) value))))

(define (tlv-put-string-body buffer text)
  (let ((bytes (string->utf8 text)))
    (tlv-put-u32 buffer (bytevector-length bytes))
    (let loop ((index 0))
      (when (< index (bytevector-length bytes))
        (tlv-buffer-put! buffer (bytevector-u8-ref bytes index))
        (loop (+ index 1))))))

(define (all-pairs? value)
  (and (pair? value)
       (let loop ((items value))
         (or (null? items)
             (and (pair? items)
                  (pair? (car items))
                  (or (symbol? (car (car items))) (string? (car (car items))))
                  (loop (cdr items)))))))

(define (tlv-encode-value buffer value)
  (cond
    ((eq? value 'dsh-null)
     (tlv-buffer-put! buffer 0))
    ((boolean? value)
     (tlv-buffer-put! buffer (if value 2 1)))
    ((eq? value 'dsh-empty-object)
     (tlv-buffer-put! buffer 7)
     (tlv-put-u32 buffer 0))
    ((and (integer? value) (exact? value))
     (tlv-buffer-put! buffer 3)
     (tlv-put-i64 buffer value))
    ((real? value)
     (when (not (finite? value)) (plugin-error 'E-TLV-RANGE))
     (tlv-buffer-put! buffer 4)
     (let ((bytes (make-bytevector 8 0)))
       (bytevector-ieee-double-native-set! bytes 0 (exact->inexact value))
       (let loop ((index 0))
         (when (< index 8)
           (tlv-buffer-put! buffer (bytevector-u8-ref bytes index))
           (loop (+ index 1))))))
    ((string? value)
     (tlv-buffer-put! buffer 5)
     (tlv-put-string-body buffer value))
    ((vector? value)
     (tlv-buffer-put! buffer 6)
     (tlv-put-u32 buffer (vector-length value))
     (let loop ((index 0))
       (when (< index (vector-length value))
         (tlv-encode-value buffer (vector-ref value index))
         (loop (+ index 1)))))
    ((list? value)
     (if (all-pairs? value)
         (begin
           (tlv-buffer-put! buffer 7)
           (tlv-put-u32 buffer (length value))
           (for-each
             (lambda (entry)
               (tlv-put-string-body buffer
                 (if (symbol? (car entry)) (symbol->string (car entry)) (car entry)))
               (tlv-encode-value buffer (cdr entry)))
             value))
         (begin
           (tlv-buffer-put! buffer 6)
           (tlv-put-u32 buffer (length value))
           (for-each (lambda (item) (tlv-encode-value buffer item)) value))))
    (else (plugin-error 'E-TLV-TYPE))))

(define (tlv-encode value)
  (let ((buffer (make-tlv-buffer)))
    (tlv-encode-value buffer value)
    (tlv-buffer-bytes buffer)))

(define (read-required-u8 port)
  (let ((byte (get-u8 port)))
    (if (eof-object? byte) (plugin-error 'E-HOST-EOF) byte)))

(define (tlv-read-u32 port)
  (let loop ((count 0) (value 0))
    (if (= count 4)
        value
        (loop (+ count 1) (+ (* value 256) (read-required-u8 port))))))

(define (tlv-read-bytes port count)
  (let ((bytes (make-bytevector count 0)))
    (let loop ((index 0))
      (when (< index count)
        (bytevector-u8-set! bytes index (read-required-u8 port))
        (loop (+ index 1))))
    bytes))

(define (tlv-read-i64 port)
  (let loop ((count 0) (value 0))
    (if (= count 8)
        (if (>= value 9223372036854775808)
            (- value 18446744073709551616)
            value)
        (loop (+ count 1) (+ (* value 256) (read-required-u8 port))))))

(define (tlv-read-value port depth)
  (when (> depth 32) (plugin-error 'E-TLV-DEPTH))
  (let ((tag (read-required-u8 port)))
    (cond
      ((= tag 0) 'dsh-null)
      ((= tag 1) #f)
      ((= tag 2) #t)
      ((= tag 3) (tlv-read-i64 port))
      ((= tag 4)
       (let ((bytes (tlv-read-bytes port 8)))
         (bytevector-ieee-double-native-ref bytes 0)))
      ((= tag 5)
       (utf8->string (tlv-read-bytes port (tlv-read-u32 port))))
      ((= tag 6)
       (let* ((count (tlv-read-u32 port))
              (items (make-vector count 0)))
         (let loop ((index 0))
           (when (< index count)
             (vector-set! items index (tlv-read-value port (+ depth 1)))
             (loop (+ index 1))))
         items))
      ((= tag 7)
       (let ((count (tlv-read-u32 port)))
         (if (= count 0)
             'dsh-empty-object
             (let loop ((index 0) (entries '()))
               (if (= index count)
                   (reverse entries)
                   (let* ((key (utf8->string (tlv-read-bytes port (tlv-read-u32 port))))
                          (value (tlv-read-value port (+ depth 1))))
                     (loop (+ index 1) (cons (cons key value) entries))))))))
      (else (plugin-error 'E-TLV-TAG)))))

(define (tlv-decode bytes)
  (let ((port (open-bytevector-input-port bytes)))
    (tlv-read-value port 0)))

(define (write-tlv-frame value)
  (ensure-channel!)
  (let* ((payload (tlv-encode value))
         (length (bytevector-length payload)))
    (when (> length MAX-FFI-FRAME) (plugin-error 'E-FFI-FRAME-TOO-LARGE))
    (let ((head (make-bytevector 4 0)))
      (bytevector-u8-set! head 0 (bitwise-and (ash length -24) 255))
      (bytevector-u8-set! head 1 (bitwise-and (ash length -16) 255))
      (bytevector-u8-set! head 2 (bitwise-and (ash length -8) 255))
      (bytevector-u8-set! head 3 (bitwise-and length 255))
      (put-bytevector dsh-channel-out head)
      (put-bytevector dsh-channel-out payload)
      (flush-output-port dsh-channel-out))))

(define (read-tlv-frame)
  (ensure-channel!)
  (let* ((length (tlv-read-u32 dsh-channel-in)))
    (when (> length MAX-FFI-FRAME) (plugin-error 'E-FFI-FRAME-TOO-LARGE))
    (tlv-decode (tlv-read-bytes dsh-channel-in length))))

(define (host-ffi-exchange rid kind rule target args token)
  (let ((frame (list
      (cons "id" "ffi")
      (cons "rid" rid)
      (cons "kind" kind)
      (cons "rule" rule)
      (cons "target" target)
      (cons "token" token)
      (cons "args" (list->vector args)))))
    (write-tlv-frame frame)
    (read-tlv-frame)))

(define (host-ffi-call id rid kind rule target args . token)
  (let* ((reply (host-ffi-exchange rid kind rule target args
                   (if (null? token) current-ffi-token (car token))))
         (ok (assoc "ok" reply)))
    (if (and ok (cdr ok))
        (respond id #t (json-value (cdr (assoc "value" reply))))
        (respond-error id (cdr (assoc "error" reply))))))

(define (host-ffi-value target args)
  (let* ((reply (host-ffi-exchange (next-ffi-rid) "ffi" current-ffi-rule target args current-ffi-token))
         (ok (assoc "ok" reply)))
    (if (and ok (cdr ok))
        (cdr (assoc "value" reply))
        (plugin-error (cdr (assoc "error" reply))))))

(define FFI-LIBRARY-SOURCE
  "(library (dsh ffi (6))
     (export ffi-call)
     (import (chezscheme))
     (define (ffi-call target . args)
       ((eval 'host-ffi-value (interaction-environment)) target args)))")

(eval (read (open-input-string FFI-LIBRARY-SOURCE)) (interaction-environment))

;; Program-controlled dynamic rules. The library is the only sanctioned way for
;; project code to publish procedures; it cannot reach the host or arbitrary
;; Chez internals through its exports.
(define dynamic-rules '())
(define rule-options '())
(define current-program-subject "")
(define current-program-ordinal 0)

(define RULES-LIBRARY-SOURCE
  "(library (dsh rules (6))
     (export register-rule! set-rule-option! rule-option)
     (import (chezscheme))
     (define (register-rule! id version proc . signature)
       ((eval 'dsh-register-rule! (interaction-environment)) id version proc
        (if (null? signature) #f (car signature))))
     (define (set-rule-option! id key value)
       ((eval 'dsh-set-rule-option! (interaction-environment)) id key value))
     (define (rule-option id key)
       ((eval 'dsh-rule-option (interaction-environment)) id key)))")

(eval (read (open-input-string RULES-LIBRARY-SOURCE)) (interaction-environment))

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

(define (attempt-error-code thunk)
  (call/cc
    (lambda (escape)
      (with-exception-handler
        (lambda (e)
          (escape (cons #f (if (plugin-error? e) (symbol->string (plugin-error-code e)) "E-PLUGIN-ERROR"))))
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
    (if (library-version? last) (version-list-string last) "")))

(define (supported-project-module-name? name)
  (and (list? name)
       (= (length name) 4)
       (eq? (car name) 'dsh)
       (memq (cadr name) '(lib plugin))
       (symbol? (caddr name))
       (library-version? (cadddr name))))

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
                              (not (equal? name '(dsh ffi (6))))
                              (not (equal? name '(dsh rules (6)))))))
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
                (list? (list-ref module 0))
                (library-version? (list-ref module 1))
                (string? (list-ref module 2))))
      (plugin-error 'E-PIN-MODULE-DESCRIPTOR)
      (let* ((expected-name (list-ref module 0))
             (expected-version (list-ref module 1))
             (desc (parse-library (list-ref module 2))))
        (unless (supported-project-module-name? (desc-name desc))
          (plugin-error 'E-PIN-MODULE-KIND (name-string (desc-name desc))))
        (unless (equal? expected-name (desc-name desc))
          (plugin-error 'E-PIN-MODULE-NAME (name-string expected-name)))
        (unless (equal? expected-version (desc-version desc))
          (plugin-error 'E-PIN-MODULE-VERSION (name-string expected-name)))
        desc)))

(define (parse-pin-plugin plugin)
  (if (not (and (list? plugin) (= (length plugin) 8)
                (eq? (car plugin) 'plugin)
                (string? (list-ref plugin 1))
                (library-version? (list-ref plugin 2))
                (string? (list-ref plugin 3))
                (string? (list-ref plugin 4))
                (string? (list-ref plugin 5))
                (list? (list-ref plugin 6))
                (string? (list-ref plugin 7))))
      (plugin-error 'E-PIN-PLUGIN-DESCRIPTOR)
      (let* ((id (list-ref plugin 1))
             (version (list-ref plugin 2))
             (kind (list-ref plugin 3))
             (path (list-ref plugin 4))
             (tree (list-ref plugin 5))
             (exports (list-ref plugin 6))
             (source (list-ref plugin 7)))
        (unless (or (string=? kind "library") (string=? kind "program"))
          (plugin-error 'E-PIN-PLUGIN-KIND id))
        (unless (string=? tree (tree-hash source))
          (plugin-error 'E-PIN-PLUGIN-TREE id))
        (when (string=? kind "library")
          (let ((desc (parse-library source)))
            (unless (eq? (desc-kind desc) 'plugin)
              (plugin-error 'E-PIN-PLUGIN-KIND id))
            (unless (equal? id (symbol->string (desc-id desc)))
              (plugin-error 'E-PIN-PLUGIN-ID id))
            (unless (equal? version (desc-version desc))
              (plugin-error 'E-PIN-PLUGIN-VERSION id))
            (unless (equal? exports (desc-exports desc))
              (plugin-error 'E-PIN-PLUGIN-EXPORTS id))))
        (list 'plugin id version kind path tree exports))))

(define (parse-program source)
  (let ((forms (read-source source)))
    (unless (pair? forms)
      (plugin-error 'E-PLUGIN-FORM-SHAPE "program requires an import form"))
    (let ((head (car forms)))
      (unless (and (list? head) (eq? (car head) 'import))
        (plugin-error 'E-PLUGIN-FORM-SHAPE "program must start with import"))
      (let ((imports (map rewrite-import-spec (cdr head)))
            (body (cdr forms)))
        (vector 'program imports body (tree-hash source))))))

(define (sorted-plugin-records plugins)
  (define (insert record rest)
    (cond ((null? rest) (list record))
          ((string<? (name-string (list (list-ref record 1) (list-ref record 2)))
                     (name-string (list (list-ref (car rest) 1) (list-ref (car rest) 2))))
           (cons record rest))
          (else (cons (car rest) (insert record (cdr rest))))))
  (let loop ((xs plugins) (out '()))
    (if (null? xs)
        out
        (loop (cdr xs) (insert (car xs) out)))))

(define (plugin-imports kind source)
  (if (string=? kind "program")
      (vector-ref (parse-program source) 1)
      (desc-imports (parse-library source))))

(define (plugin-bundle-hash kind tree imports)
  (domain-hash "dsh/plugin-bundle/v2"
    (list 'plugin-bundle tree kind (pin-project-import-names imports))))

(define (plugin-environment-record plugin)
  (let* ((record (parse-pin-plugin plugin))
         (id (list-ref record 1))
         (version (list-ref record 2))
         (kind (list-ref record 3))
         (path (list-ref record 4))
         (tree (list-ref record 5))
         (exports (list-ref record 6))
         (source (list-ref plugin 7))
         (bundle (plugin-bundle-hash kind tree (plugin-imports kind source))))
    (list 'plugin id version kind path tree exports bundle '())))

(define (plugin-environment-hash plugins)
  (domain-hash "dsh/plugin-environment/v2"
    (cons 'plugin-environment
          (sorted-plugin-records (map plugin-environment-record plugins)))))

(define (pin-rule-hash rule-id version tree bundle signature plugin-env ffi-env)
  (domain-hash "dsh/rule/v2"
    (list 'rule rule-id version tree bundle signature plugin-env ffi-env)))

(define (pin-values rule-id version source modules plugins ffi signature)
  (let* ((tree (tree-hash source))
         (bundle (pin-bundle-hash modules))
         (plugin-env (plugin-environment-hash plugins))
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
  (if (not (and (pair? desc) (eq? (car desc) 'rule) (>= (length desc) 8)
                (string? (list-ref desc 1))
                (library-version? (list-ref desc 2))))
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
(define pin-plugin-forms '())
(define pin-program-forms '())
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

(define pin-rule-procedures '())
(define pin-plugin-procedures '())

(define (pin-rule-procedure id name env-spec)
  (let ((key (cons id name)))
    (let ((hit (assoc key pin-rule-procedures)))
      (if hit
          (cdr hit)
          (let ((proc (eval (string->symbol name) (environment env-spec))))
            (set! pin-rule-procedures (cons (cons key proc) pin-rule-procedures))
            proc)))))

(define (pin-plugin-procedure id version name env-spec)
  (let ((key (list id version name)))
    (let ((hit (assoc key pin-plugin-procedures)))
      (if hit
          (cdr hit)
          (let ((proc (eval (string->symbol name) (environment env-spec))))
            (set! pin-plugin-procedures (cons (cons key proc) pin-plugin-procedures))
            proc)))))

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
                                    (apply (pin-rule-procedure rule-id procedure
                                               (caddr entry))
                                           args))
                                  (lambda () (set! current-ffi-rule previous))))))))
                    (if (car result)
                        (respond id #t (json-value (cdr result)))
                        (respond-error id "E-RULE-ERROR")))))))))

(define (plugin-form plugin)
  (let* ((record (parse-pin-plugin plugin))
         (id (list-ref record 1))
         (version (list-ref record 2))
         (kind (list-ref record 3))
         (source (list-ref plugin 7)))
    (if (string=? kind "library")
        (let* ((desc (parse-library source))
               (subject (plugin-subject-hash id version kind
                          (desc-tree desc) (desc-imports desc))))
          (list id version 'library (desc-name desc) (desc-exports desc) subject))
        (list id version 'program #f '() #f))))
(define (plugin-dependency-names desc)
  (let ((all (project-import-names (desc-imports desc))))
    (let loop ((names all) (out '()))
      (cond ((null? names) (reverse out))
            ((and (string? (car names))
                  (> (string-length (car names)) 12)
                  (string=? (substring (car names) 0 12) "(dsh plugin "))
             (loop (cdr names) (cons (car names) out)))
            (else (loop (cdr names) out))))))

(define (module-dependency-names desc)
  (let loop ((names (project-import-names (desc-imports desc))) (out '()))
    (cond ((null? names) (reverse out))
          ((and (string? (car names))
                (> (string-length (car names)) 9)
                (string=? (substring (car names) 0 9) "(dsh lib "))
           (loop (cdr names) (cons (car names) out)))
          (else (loop (cdr names) out)))))

(define (topo-sort-descs descs dependencies)
  (let ((by-name (map (lambda (d) (cons (name-string (desc-name d)) d)) descs))
        (visiting '())
        (done '())
        (out '()))
    (define (visit name)
      (cond
        ((member name done) #f)
        ((member name visiting) (plugin-error 'E-PLUGIN-DAG))
        (else
         (set! visiting (cons name visiting))
         (let* ((entry (assoc name by-name))
                (desc (cdr entry)))
           (for-each
             (lambda (dependency)
               (when (assoc dependency by-name) (visit dependency)))
             (dependencies desc))
           (set! visiting (filter (lambda (x) (not (equal? x name))) visiting))
           (set! done (cons name done))
           (set! out (cons desc out))))))
    (for-each (lambda (entry) (visit (car entry))) by-name)
    (reverse out)))

(define (plugin-topo-sort descs)
  (topo-sort-descs descs plugin-dependency-names))

(define (module-topo-sort descs)
  (topo-sort-descs descs module-dependency-names))

(define (pin-plugin-call id desc)
  (if (not (and (pair? desc) (eq? (car desc) 'plugin-call) (>= (length desc) 6)))
      (respond-error id "E-PLUGIN-CALL-DESCRIPTOR")
      (let* ((plugin-id (list-ref desc 1))
             (version (list-ref desc 2))
             (procedure (list-ref desc 3))
             (args (list-ref desc 4))
             (subject (list-ref desc 5)))
        (if (not (and pin-loaded? (string? plugin-id) (library-version? version)
                      (string? procedure) (list? args)))
            (respond-error id "E-PIN-NOT-LOADED")
            (let ((entry (find (lambda (candidate)
                                 (and (string=? (list-ref candidate 0) plugin-id)
                                      (equal? (list-ref candidate 1) version)))
                               pin-plugin-forms)))
              (cond
                ((not entry) (respond-error id "E-PLUGIN-ID"))
                ((not (eq? (list-ref entry 2) 'library))
                 (respond-error id "E-PLUGIN-KIND"))
                ((not (memq (string->symbol procedure) (list-ref entry 4)))
                 (respond-error id "E-PLUGIN-EXPORT"))
                ((not (and (string? (list-ref entry 5))
                           (string=? subject (list-ref entry 5))))
                 (respond-error id "E-PLUGIN-SUBJECT"))
                (else
                 (let ((result
                         (attempt
                           (lambda ()
                             (pin-eval-project!)
                             (let ((previous current-ffi-rule))
                               (set! current-ffi-rule (list-ref entry 5))
                               (dynamic-wind
                                 void
                                 (lambda ()
                                   (apply (pin-plugin-procedure (list-ref entry 0) (list-ref entry 1) procedure (list-ref entry 3)) args))
                                 (lambda () (set! current-ffi-rule previous))))))))
                   (if (car result)
                       (respond id #t (json-value (cdr result)))
                       (respond-error id "E-PLUGIN-ERROR"))))))))))

(define (plugin-subject-hash id version kind tree imports)
  (let* ((bundle (plugin-bundle-hash kind tree imports)))
    (domain-hash "dsh/plugin-subject/v2"
      (list 'plugin-subject id version kind tree bundle))))

(define (dynamic-rule-find id version)
  (find (lambda (entry)
          (and (equal? (symbol->string (list-ref entry 0)) id)
               (equal? (list-ref entry 1) version)))
        dynamic-rules))

(define (static-rule-exists? id version)
  (let loop ((entries pin-registry))
    (cond ((null? entries) #f)
          ((and (string=? (list-ref (car entries) 0) id)
                (equal? (list-ref (car entries) 1) version)) #t)
          (else (loop (cdr entries))))))

(define (dsh-register-rule! id version proc signature)
  (unless (symbol? id) (plugin-error 'E-PLUGIN-RULE-ID))
  (unless (and (library-version? version) (pair? version))
    (plugin-error 'E-PLUGIN-RULE-VERSION))
  (unless (procedure? proc) (plugin-error 'E-PLUGIN-RULE-PROCEDURE))
  (when (or (static-rule-exists? (symbol->string id) version)
            (dynamic-rule-find (symbol->string id) version))
    (plugin-error 'E-DUPLICATE-RULE id))
  (let ((subject (domain-hash "dsh/dynamic-rule/v2"
                   (list 'dynamic-rule current-program-subject
                         (symbol->string id) version current-program-ordinal))))
    (set! current-program-ordinal (+ current-program-ordinal 1))
    (set! dynamic-rules
      (append dynamic-rules (list (list id version proc signature subject current-program-subject))))
    subject))

(define (dsh-set-rule-option! id key value)
  (unless (symbol? id) (plugin-error 'E-PLUGIN-RULE-ID))
  (unless (symbol? key) (plugin-error 'E-RULE-OPTION-KEY))
  (set! rule-options
    (cons (list id key value)
          (filter (lambda (entry)
                    (not (and (eq? (car entry) id) (eq? (cadr entry) key))))
                  rule-options))))

(define (dsh-rule-option id key)
  (unless (symbol? id) (plugin-error 'E-PLUGIN-RULE-ID))
  (unless (symbol? key) (plugin-error 'E-RULE-OPTION-KEY))
  (let ((entry (find (lambda (candidate)
                       (and (eq? (car candidate) id) (eq? (cadr candidate) key)))
                     rule-options)))
    (if entry
        (caddr entry)
        (plugin-error 'E-RULE-OPTION))))

(define (pin-dynamic-call id desc)
  (if (not (and (pair? desc) (eq? (car desc) 'dynamic-call) (>= (length desc) 5)))
      (respond-error id "E-RULE-CALL-DESCRIPTOR")
      (let* ((rule-id (list-ref desc 1))
             (version (list-ref desc 2))
             (args (list-ref desc 3))
             (subject (list-ref desc 4)))
        (if (not (and pin-loaded? (string? rule-id) (library-version? version)
                      (list? args) (string? subject)))
            (respond-error id "E-PIN-NOT-LOADED")
            (let ((entry (dynamic-rule-find rule-id version)))
              (cond
                ((not entry) (respond-error id "E-RULE-NOT-LOADED"))
                ((not (string=? subject (list-ref entry 4)))
                 (respond-error id "E-RULE-SUBJECT"))
                (else
                 (let ((result
                         (attempt
                           (lambda ()
                             (let ((previous current-ffi-rule))
                               (set! current-ffi-rule (list-ref entry 5))
                               (dynamic-wind
                                 void
                                 (lambda () (apply (list-ref entry 2) args))
                                 (lambda () (set! current-ffi-rule previous))))))))
                   (if (car result)
                       (respond id #t (json-value (cdr result)))
                       (respond-error id "E-RULE-ERROR"))))))))))

(define (program-result-json value)
  (json-value value))

(define (join-raw items)
  (if (null? items)
      ""
      (string-append (car items)
                     (if (null? (cdr items)) "" (string-append "," (join-raw (cdr items)))))))

(define (pin-run-programs id)
  (if (not pin-loaded?)
      (respond-error id "E-PIN-NOT-LOADED")
      (let loop ((entries pin-program-forms) (results '()))
        (if (null? entries)
            (let* ((programs
                     (map (lambda (entry)
                            (string-append
                              "{\"id\":\"" (json-escape (list-ref entry 0)) "\""
                              ",\"version\":" (json-value (list-ref entry 1))
                              ",\"result\":" (list-ref entry 2) "}"))
                          (reverse results)))
                   (rules
                     (map (lambda (entry)
                            (string-append
                              "{\"id\":\"" (json-escape (symbol->string (list-ref entry 0))) "\""
                              ",\"version\":" (json-value (list-ref entry 1))
                              ",\"subject\":\"" (json-escape (list-ref entry 4)) "\""
                              ",\"programSubject\":\"" (json-escape (list-ref entry 5)) "\"}"))
                          dynamic-rules)))
              (respond id #t
                (string-append
                  "{\"programs\":[" (join-raw programs) "]"
                  ",\"rules\":[" (join-raw rules) "]}")))
            (let* ((entry (car entries))
                   (program-id (list-ref entry 0))
                   (version (list-ref entry 1))
                   (imports (list-ref entry 2))
                   (body (list-ref entry 3))
                   (tree (list-ref entry 4)))
              (set! current-program-subject
                (plugin-subject-hash program-id version "program" tree imports))
              (set! current-program-ordinal 0)
              (let ((result
                      (attempt-error-code
                        (lambda ()
                          (pin-eval-project!)
                          (let ((env (if (null? imports)
                                         (environment '(rnrs base (6)))
                                         (apply environment imports)))
                                (previous current-ffi-rule))
                            (set! current-ffi-rule (list-ref entry 5))
                            (dynamic-wind
                              void
                              (lambda ()
                                (let eval-body ((forms body) (last #f))
                                  (if (null? forms)
                                      last
                                      (eval-body (cdr forms) (eval (car forms) env)))))
                              (lambda () (set! current-ffi-rule previous))))))))
                (if (car result)
                    (let ((encoded (attempt (lambda () (program-result-json (cdr result))))))
                      (if (car encoded)
                          (loop (cdr entries)
                                (cons (list program-id version (cdr encoded))
                                      results))
                          (respond-error id "E-PLUGIN-RESULT")))
                    (respond-error id (cdr result)))))))))

(define (pin-load id desc)
  (if (not (and (pair? desc) (eq? (car desc) 'pin) (>= (length desc) 5)))
      (respond-error id "E-PIN-LOAD-DESCRIPTOR")
      (let* ((plugins (list-ref desc 1))
             (ffi (list-ref desc 2))
             (modules (list-ref desc 3))
             (rules (list-ref desc 4))
             (token (if (>= (length desc) 6) (list-ref desc 5) ""))
             (raw-module-descs (map parse-pin-module modules))
             (module-descs
              (begin
                (let loop ((names (map desc-name raw-module-descs)))
                  (unless (null? names)
                    (when (member (car names) (cdr names))
                      (plugin-error 'E-DUPLICATE-LIBRARY (car names)))
                    (loop (cdr names))))
                (module-topo-sort raw-module-descs)))
             (plugin-forms (map plugin-form plugins))
             (plugin-descs
              (let loop ((ps plugins) (out '()))
                (if (null? ps)
                    (reverse out)
                    (let* ((record (parse-pin-plugin (car ps)))
                           (kind (list-ref record 3))
                           (source (list-ref (car ps) 7)))
                      (loop (cdr ps)
                            (if (string=? kind "library")
                                (cons (parse-library source) out)
                                out))))))
             (program-forms
              (let loop ((ps plugins) (out '()))
                (if (null? ps)
                    (reverse out)
                    (let* ((record (parse-pin-plugin (car ps)))
                           (kind (list-ref record 3))
                           (id (list-ref record 1))
                           (version (list-ref record 2))
                           (source (list-ref (car ps) 7)))
                      (if (string=? kind "program")
                          (let ((desc (parse-program source)))
                            (loop (cdr ps)
                                  (cons (list id version
                                              (vector-ref desc 1)
                                              (vector-ref desc 2)
                                              (vector-ref desc 3)
                                              (plugin-subject-hash id version "program"
                                                (vector-ref desc 3) (vector-ref desc 1)))
                                        out)))
                          (loop (cdr ps) out))))))
             (rule-descs (map (lambda (r) (parse-library (list-ref r 3))) rules))
             (sorted-plugin-descs (plugin-topo-sort plugin-descs))
             (all-descs (append module-descs sorted-plugin-descs rule-descs))
             (names (map desc-name all-descs))
             (module-names (map desc-name (append module-descs sorted-plugin-descs)))
             (plugin-subjects
              (map (lambda (entry)
                     (string-append
                       "{\"id\":\"" (json-escape (list-ref entry 0)) "\""
                       ",\"version\":" (json-value (list-ref entry 1))
                       ",\"subject\":\"" (json-escape (list-ref entry 5)) "\"}"))
                   (filter (lambda (entry) (eq? (list-ref entry 2) 'library))
                           plugin-forms)))
             (program-subjects
              (map (lambda (entry)
                     (string-append
                       "{\"id\":\"" (json-escape (list-ref entry 0)) "\""
                       ",\"version\":" (json-value (list-ref entry 1))
                       ",\"subject\":\"" (json-escape (list-ref entry 5)) "\"}"))
                   program-forms)))
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
        ;; Programs are also keyed by id + version-list for programResult.
        (let loop ((ps program-forms))
          (unless (null? ps)
            (let ((key (list (caar ps) (cadar ps))))
              (when (member key (map (lambda (p) (list (car p) (cadr p))) (cdr ps)))
                (plugin-error 'E-DUPLICATE-PROGRAM (caar ps))))
            (loop (cdr ps))))
        ;; Import edges may close over declared project libraries only. Rules are
        ;; not libraries that modules or rules may import.
        (for-each (lambda (d) (validate-imports! (desc-imports d) module-names)) all-descs)
        (for-each (lambda (p) (validate-imports! (list-ref p 2) module-names)) program-forms)
        ;; Recompute every hash from the exact source that will be published.
        (for-each
          (lambda (r d)
            (unless (equal? (list-ref r 1) (symbol->string (desc-id d)))
              (plugin-error 'E-PIN-RULE-ID (list-ref r 1)))
            (unless (equal? (list-ref r 2) (desc-version d))
              (plugin-error 'E-PIN-RULE-VERSION (list-ref r 1)))
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
          rules rule-descs)
        ;; Publish only after all checks: a later failure leaves the old registry.
        (set! pin-registry
          (map (lambda (r d)
                 (list (list-ref r 1) (list-ref r 2) (desc-name d)
                       (desc-tree d) (list-ref r 6) (list-ref r 9)))
               rules rule-descs))
        (set! pin-plugin-forms plugin-forms)
        (set! pin-program-forms program-forms)
        (set! dynamic-rules '())
        (set! rule-options '())
        (set! pin-module-forms (map desc-form (append module-descs sorted-plugin-descs)))
        (set! pin-rule-forms
          (map (lambda (r d)
                 (list (list-ref r 1) (desc-form d) (desc-name d) (list-ref r 9)))
               rules rule-descs))
        (set! pin-rule-procedures '())
        (set! pin-plugin-procedures '())
        (set! pin-evaluated? #f)
        (set! pin-eval-failed? #f)
        (set! pin-loaded? #t)
        (set! current-ffi-token token)
        (let ((evaluation (attempt (lambda () (pin-eval-project!)))))
          (if (car evaluation)
              (respond id #t
                (string-append "{\"loaded\":true,\"rules\":" (number->string (length rules))
                               ",\"modules\":" (number->string (length modules))
                               ",\"plugins\":" (number->string (length plugins))
                               ",\"programs\":" (number->string (length program-forms))
                               ",\"subjects\":[" (join-raw plugin-subjects) "]"
                               ",\"programSubjects\":[" (join-raw program-subjects) "]"
                               ",\"registry\":" (number->string (length pin-registry)) "}"))
              (respond-error id "E-PLUGIN-ERROR"))))))

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
          ((pin-run-programs) (pin-run-programs id))
          ((pin-gc) (collect) (respond id #t "{\"collected\":true}"))
          ((pin-dynamic-call) (pin-dynamic-call id arg))
          ((pin-call) (pin-call id arg))
          ((pin-plugin-call) (pin-plugin-call id arg))
          ((source-tree-hash) (respond id #t (json-value (tree-hash arg))))
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
                  (respond "?" #f (string-append "\"" (json-escape (if (condition? e) (format "~a / ~a / ~s" (condition-message e) (condition-who e) (condition-irritants e)) (format "~a" e))) "\"")))))
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
