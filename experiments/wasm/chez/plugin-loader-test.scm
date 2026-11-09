(load "/plugin-loader.scm")

(define passed 0)
(define failed 0)

(define (report name ok detail)
  (if ok (set! passed (+ passed 1)) (set! failed (+ failed 1)))
  (display "CASE ") (display name) (display " ")
  (display (if ok "PASS" "FAIL"))
  (display " ") (write detail) (newline))

(define (check-value name expected thunk)
  (guard (e (#t (report name #f (if (plugin-error? e) (plugin-error-code e) e))))
    (let ((actual (thunk)))
      (report name (equal? actual expected) actual))))

(define (check-code name expected thunk)
  (guard (e ((plugin-error? e)
             (report name (eq? (plugin-error-code e) expected) (plugin-error-code e)))
            (#t (report name #f e)))
    (thunk)
    (report name #f "no error")))

(define good-source
  "(library (dsh plugin demo v1)
     (export answer)
     (import (rnrs base (6)))
     (define (answer) 42))")

(define good-source-v2
  "(library (dsh plugin demo v2)
     (export answer)
     (import (rnrs base (6)))
     (define (answer) 43))")

(define denied-source
  "(library (dsh plugin denied v1)
     (export answer)
     (import (chezscheme))
     (define (answer) 1))")

(define missing-export-source
  "(library (dsh plugin missing v1)
     (export missing)
     (import (rnrs base (6)))
     (define (answer) 1))")

(define fresh-source
  "(library (dsh plugin fresh v1)
     (export answer)
     (import (rnrs base (6)))
     (define (answer) 7))")

(define util-source
  "(library (dsh lib util v1)
     (export double)
     (import (rnrs base (6)))
     (define (double x) (* 2 x)))")

(define util-source-2
  "(library (dsh lib util v1)
     (export double)
     (import (rnrs base (6)))
     (define (double x) (+ x x)))")

(define util-plugin-source
  "(library (dsh plugin uses-util v1)
     (export answer)
     (import (rnrs base (6)) (dsh lib util v1))
     (define (answer) (double 21)))")

(define missing-import-source
  "(library (dsh plugin missing-import v1)
     (export answer)
     (import (rnrs base (6)) (dsh lib no-such v1))
     (define (answer) 1))")

(define dynamic-safe-source
  "(library (dsh plugin dyn-safe v1)
     (export answer)
     (import (rnrs base (6)) (rnrs eval (6)))
     (define (answer) (eval '(+ 1 2) (environment '(rnrs base (6))))))")

(define dynamic-denied-source
  "(library (dsh plugin dyn-denied v1)
     (export answer)
     (import (rnrs base (6)) (rnrs eval (6)))
     (define (answer) (eval '(+ 1 2) (environment '(chezscheme)))))")

(define composite-denied-source
  "(library (dsh plugin composite v1)
     (export answer)
     (import (rnrs (6)))
     (define (answer) 1))")

(check-value "load-good" 42 (lambda () (begin (load-plugin-source! good-source) (plugin-call 'demo 'answer))))
(check-value "plugin-count" 1 (lambda () (plugin-count)))
(check-code "duplicate-plugin" 'E-DUPLICATE-PLUGIN (lambda () (load-plugin-source! good-source-v2)))
(check-code "denied-import" 'E-IMPORT-DENIED (lambda () (load-plugin-source! denied-source)))
(check-code "hash-mismatch" 'E-TREE-HASH-MISMATCH (lambda () (load-plugin-source! good-source "deadbeef")))
(check-value "registry-after-failures" 1 (lambda () (plugin-count)))

(check-value "bundle-util" 42
  (lambda () (begin (load-bundle! (list util-source util-plugin-source))
                    (plugin-call 'uses-util 'answer))))
(check-value "library-count" 3 (lambda () (library-count)))
(check-code "duplicate-library" 'E-DUPLICATE-LIBRARY
  (lambda () (load-bundle! (list util-source util-source))))
(check-code "missing-import" 'E-IMPORT-DENIED
  (lambda () (load-bundle! (list missing-import-source))))
(check-code "unknown-plugin" 'E-UNKNOWN-PLUGIN
  (lambda () (plugin-call 'no-such 'answer)))
(check-code "unknown-export" 'E-UNKNOWN-EXPORT
  (lambda () (plugin-call 'demo 'no-such)))
(check-value "dynamic-import-safe" 3
  (lambda () (begin (load-plugin-source! dynamic-safe-source)
                    (plugin-call 'dyn-safe 'answer))))
(check-code "dynamic-import-denied" 'E-IMPORT-DENIED
  (lambda () (begin (load-plugin-source! dynamic-denied-source)
                    (plugin-call 'dyn-denied 'answer))))
(check-code "composite-import-denied" 'E-IMPORT-DENIED
  (lambda () (load-plugin-source! composite-denied-source)))

;; A bundle with one valid library followed by an evaluation failure must not
;; publish either library, and the incarnation must become unusable for loads.
(define plugins-before-failed-bundle (plugin-count))
(define libraries-before-failed-bundle (library-count))
(check-code "bundle-missing-export" 'E-EXPORT-MISSING
  (lambda () (load-bundle! (list fresh-source missing-export-source))))
(check-value "registry-unchanged-after-failed-bundle" #t
  (lambda () (= (plugin-count) plugins-before-failed-bundle)))
(check-value "libraries-unchanged-after-failed-bundle" #t
  (lambda () (= (library-count) libraries-before-failed-bundle)))
(check-code "vm-poisoned" 'E-VM-POISONED
  (lambda () (load-plugin-source! good-source-v2)))
(check-code "existing-plugin-after-poison" 'E-VM-POISONED
  (lambda () (plugin-call 'demo 'answer)))

(let ((a (bundle-hash (list (parse-library util-source))))
      (b (bundle-hash (list (parse-library util-source-2)))))
  (report "bundle-hash-changes" (not (string=? a b)) (list a b)))

(let* ((base (parse-library util-source))
       (with-import (vector-copy base))
       (with-version (vector-copy base)))
  (vector-set! with-import 6 '((only (dsh lib other v1) x)))
  (vector-set! with-version 4 'v2)
  (let ((h0 (bundle-hash (list base)))
        (h1 (bundle-hash (list with-import)))
        (h2 (bundle-hash (list with-version))))
    (report "bundle-hash-imports" (not (string=? h0 h1)) (list h0 h1))
    (report "bundle-hash-version" (not (string=? h0 h2)) (list h0 h2))))

(display "SUMMARY ") (display passed) (display " ") (display failed) (newline)
(exit (if (= failed 0) 0 1))
